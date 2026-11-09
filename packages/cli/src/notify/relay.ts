export * as Relay from "./relay"

import { Attention } from "@opencode/schema/attention"
import { Product } from "@opencode/schema/product"
import path from "node:path"
import { Option, Schema } from "effect"
import { errorMessage } from "../util/error"

// `openforge notify <ssh-target>` and `notify --via <command>`: the player starts `openforge notify --relay` on the
// other machine. The relay follows its own service and writes what it gets to stdout, one JSON object per line, so no
// port is forwarded and the service's password stays on that machine. The relay ends when its stdin closes.

/** The line format; the relay's first line says which one it writes. */
export const VERSION = 1
/** How often a relay says it is alive, so the player notices a connection that died without closing. */
export const ALIVE_MS = 15_000
/** What the remote command writes to stderr when it finds no openforge. */
export const NOT_FOUND = `${Product.binary}-notify: ${Product.name} is not installed here`
// A custom sound file larger than this is not sent; the player plays the built-in sound instead.
const SOUND_FILE_LIMIT = 4 * 1024 * 1024

/** A custom sound file the TUI named, read by the relay and sent with the first occurrence that names it. */
const SoundFile = Schema.Union([
  Schema.Struct({ file: Schema.String, data: Schema.String }),
  Schema.Struct({ file: Schema.String, error: Schema.String }),
])

export const Line = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), version: Schema.Number }),
  /** For the person at the player: no service runs, the service went away. */
  Schema.Struct({ type: Schema.Literal("status"), text: Schema.String }),
  /** Only with --verbose. */
  Schema.Struct({ type: Schema.Literal("debug"), text: Schema.String }),
  /** The relay follows its service. */
  Schema.Struct({ type: Schema.Literal("following"), url: Schema.String, version: Schema.String }),
  Schema.Struct({ type: Schema.Literal("alive") }),
  Schema.Struct({
    type: Schema.Literal("occurrence"),
    occurrence: Attention.Occurrence,
    test: Schema.optionalKey(Schema.Literal(true)),
    sound: Schema.optionalKey(SoundFile),
  }),
])
export type Line = typeof Line.Type
export type Encoded = typeof Line.Encoded

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line))

export function encode(line: Encoded) {
  return `${JSON.stringify(line)}\n`
}

/** A relay line, or none for anything else (what a shell startup file on the other machine printed). */
export function decode(text: string) {
  return Option.getOrUndefined(decodeLine(text))
}

/** The relay's flags, passed on from the player: fixed words only. */
export function flags(input: { readonly desktop: boolean; readonly test?: string; readonly verbose: boolean }) {
  return [
    ...(input.desktop ? ["--desktop"] : []),
    ...(input.test === undefined ? [] : [`--test=${input.test}`]),
    ...(input.verbose ? ["--verbose"] : []),
  ]
}

/**
 * Finds openforge on the other machine and runs the relay: from PATH, else where the installer puts it. A command run
 * without a login shell (`--via`, a non-interactive ssh shell) often has a shorter PATH than a terminal.
 */
export function script(relayFlags: readonly string[]) {
  const binary = Product.binary
  const command = ["notify", "--relay", ...relayFlags].join(" ")
  return `for c in ${binary} "$HOME/.local/bin/${binary}"; do if command -v "$c" >/dev/null 2>&1; then exec "$c" ${command}; fi; done; echo "${NOT_FOUND}" >&2; exit 127`
}

export type Route = { readonly target: string } | { readonly via: readonly string[] }

/**
 * The command that starts the relay. `--via` runs its arguments on the other machine as they are (as `docker exec`
 * does), so the script goes as `sh -c <script>`; ssh hands its command to the login shell there, so it goes quoted.
 * A `--via` command whose program is ssh joins its words into one line for that shell too, so it gets the quoted
 * script as well. The script has no single quote or backslash, so the quoting holds in sh and in fish.
 */
export function command(route: Route, relayFlags: readonly string[]) {
  if ("via" in route && path.basename(route.via[0] ?? "") === "ssh")
    return [...route.via, `sh -c '${script(relayFlags)}'`]
  if ("via" in route) return [...route.via, "sh", "-c", script(relayFlags)]
  return [
    "ssh",
    "-T",
    "-o",
    "ConnectTimeout=20",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "--",
    route.target,
    `sh -c '${script(relayFlags)}'`,
  ]
}

/** Splits `--via` into words; a command that needs quoting goes in a script of its own. */
export function via(text: string) {
  return text.trim().split(/\s+/).filter(Boolean)
}

/** Why the relay's command ended, from its exit code and the last line it wrote to stderr. */
export function ended(label: string, ssh: boolean, code: number | null, last: string) {
  if (code === 127 && last.includes(NOT_FOUND))
    return `${Product.name} is not installed on ${label} (looked on PATH and in ~/.local/bin)`
  if (ssh && code === 255) return `ssh ${label} failed${last === "" ? "" : `: ${last}`}`
  return `the relay on ${label} ended (exit ${code ?? "by signal"}${last === "" ? "" : `: ${last}`})`
}

/**
 * The relay's side: each occurrence as a line, a custom sound file read here and sent the first time it is named
 * (again after a failed read).
 */
export function createSender(write: (line: Encoded) => void, read: (file: string) => Promise<Uint8Array>) {
  const sent = new Set<string>()
  // In order: the copy of an occurrence from a second TUI comes after the first, and its file is not sent twice.
  const queue = { tail: Promise.resolve() }
  const one = async (event: { readonly occurrence: typeof Attention.Occurrence.Encoded; readonly test?: true }) => {
    const file = event.occurrence.sound?.file
    if (file === undefined || sent.has(file)) return write({ type: "occurrence", ...event })
    const sound = await read(file).then(
      (bytes) =>
        bytes.byteLength > SOUND_FILE_LIMIT
          ? { file, error: `it is larger than ${SOUND_FILE_LIMIT / 1024 / 1024} MB` }
          : { file, data: Buffer.from(bytes).toString("base64") },
      (error: unknown) => ({ file, error: errorMessage(error) }),
    )
    if ("data" in sound) sent.add(file)
    write({ type: "occurrence", ...event, sound })
  }
  return (event: Parameters<typeof one>[0]) => {
    queue.tail = queue.tail.then(() => one(event))
    return queue.tail
  }
}
