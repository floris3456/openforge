export * as Sandbox from "./sandbox.js"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConfigSandbox } from "@opencode/schema/config/sandbox"
import { landlock, seccomp } from "#native"
import { entries, inside, real, text } from "./files.js"
import { Landlock } from "./landlock.js"
import { Seatbelt } from "./seatbelt.js"

// Which shell commands may write and read where, and how a command is started inside that. Linux confines with
// Landlock and seccomp in `openforge sandbox-exec`; macOS runs `/usr/bin/sandbox-exec` with a Seatbelt profile.
// It guards against mistakes, not against a hostile model: local services, sockets and signals are not blocked.

export const merge = ConfigSandbox.merge
export const permission = ConfigSandbox.permission

type Env = Readonly<Record<string, string | undefined>>

export interface Context {
  /** The chat's folder. */
  readonly directory: string
  /** The checkout the chat's folder belongs to; writable too, unless it is the filesystem root. */
  readonly worktree?: string
  readonly home: string
  /** openforge's own folders (`Global.Path`). */
  readonly data: string
  readonly state: string
  readonly config: string
  /** The live database, when it isn't `<data>/opencode.db`. */
  readonly database?: string
  /** The command's environment: its TMPDIR and cache variables add writable folders. Default: this process's. */
  readonly env?: Env
}

/** A concrete policy, of resolved absolute paths. */
export interface Policy {
  readonly mode: ConfigSandbox.Mode
  readonly network: boolean
  readonly required: boolean
  readonly write: readonly string[]
  readonly denyRead: readonly string[]
  readonly platform: NodeJS.Platform
  readonly home: string
}

/** The part of a policy that Landlock and Seatbelt enforce. */
export type Confinement = Pick<Policy, "write" | "denyRead" | "network">

export type Availability = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** How a policy confines commands on a machine. */
export type Decision =
  /** Not at all: the policy is off, or the machine can't sandbox and the policy doesn't require it. */
  | { readonly type: "none" }
  | { readonly type: "sandbox"; readonly mode: "write" | "read"; readonly network: boolean }
  /** Commands are refused: the machine can't sandbox, and the policy requires it. */
  | { readonly type: "refused"; readonly reason: string }

export type Argv = readonly [string, ...string[]]

export type Wrapped =
  | {
      readonly type: "run"
      readonly argv: Argv
      readonly sandboxed: boolean
      /** Set on the first command of this process that runs unsandboxed because the machine can't sandbox. */
      readonly warning?: string
    }
  | { readonly type: "refuse"; readonly reason: string }

const SEATBELT = "/usr/bin/sandbox-exec"

export function resolve(settings: ConfigSandbox.Info | undefined, context: Context): Policy {
  const env = context.env ?? process.env
  const mode = settings?.mode ?? "write"
  const home = real(context.home)
  const base = {
    mode,
    network: settings?.network ?? true,
    required: settings?.required ?? false,
    platform: process.platform,
    home,
  }
  if (mode === "off") return { ...base, write: [], denyRead: [] }
  const temp = temporary(home, env)
  const own = (value: string) => real(absolute(value, context))
  const roots = [
    context.directory,
    ...(context.worktree && path.dirname(context.worktree) !== context.worktree ? [context.worktree] : []),
  ].map(real)
  const write =
    mode === "write"
      ? [
          ...roots,
          ...git(roots[0]).filter((folder) => !roots.some((root) => inside(folder, root))),
          ...temp,
          ...caches(home, env, temp),
          "/dev",
          ...(settings?.write ?? []).map(own),
        ]
      : [...temp, "/dev"]
  return {
    ...base,
    write: unique(write),
    denyRead: unique([...secrets(context), ...(settings?.deny_read ?? []).map(own)]),
  }
}

let availability: Availability | undefined

/** Whether this machine can sandbox, worked out once per process. */
export function available() {
  return (availability ??= process.versions.bun
    ? detect(process.platform)
    : { ok: false, reason: "the sandbox needs openforge's Bun build" })
}

export function detect(
  platform: NodeJS.Platform,
  probe = { landlock, seccomp, seatbelt: () => fs.existsSync(SEATBELT) },
): Availability {
  if (platform === "darwin") return probe.seatbelt() ? { ok: true } : { ok: false, reason: `${SEATBELT} is missing` }
  if (platform !== "linux") return { ok: false, reason: `there is no sandbox on ${platform}` }
  try {
    const reason =
      Landlock.unsupported(probe.landlock()) ?? (probe.seccomp() ? undefined : "this kernel has no seccomp filters")
    return reason === undefined ? { ok: true } : { ok: false, reason }
  } catch (error) {
    // The C library didn't load.
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function decide(policy: Policy, machine: Availability = available()): Decision {
  if (policy.mode === "off") return { type: "none" }
  if (!machine.ok) return policy.required ? { type: "refused", reason: machine.reason } : { type: "none" }
  return { type: "sandbox", mode: policy.mode, network: policy.network }
}

let warned = false

/**
 * The argv that runs `argv` under `policy`. `self` starts this openforge (`selfCommand()`), whose hidden
 * `sandbox-exec` command confines itself on Linux. When the machine can't sandbox, the command runs unsandboxed, or
 * is refused when the policy requires the sandbox.
 */
export function wrap(policy: Policy, argv: Argv, self: Argv, machine: Availability = available()): Wrapped {
  const decision = decide(policy, machine)
  const cannot = (reason: string) => `This machine can't sandbox commands: ${reason}.`
  if (decision.type === "refused")
    return { type: "refuse", reason: `${cannot(decision.reason)} The command was not run, as sandbox.required is set.` }
  if (decision.type === "sandbox") {
    if (policy.platform === "darwin")
      return { type: "run", argv: [SEATBELT, "-p", Seatbelt.profile(policy), ...argv], sandboxed: true }
    return { type: "run", argv: [...self, "sandbox-exec", Landlock.encode(policy), "--", ...argv], sandboxed: true }
  }
  if (policy.mode === "off" || machine.ok || warned) return { type: "run", argv, sandboxed: false }
  warned = true
  return { type: "run", argv, sandboxed: false, warning: `${cannot(machine.reason)} Commands run unsandboxed.` }
}

/** The note added to the result of a sandboxed command that failed: where it may write, and how to go outside. */
export function note(policy: Policy) {
  if (policy.mode === "off") return undefined
  const places = policy.write.map((item) => shorten(item, policy.home)).join(", ")
  return [
    `This command ran in the sandbox, which lets it write only to ${places}${policy.network ? "" : ", and gives it no network"}.`,
    `If the sandbox stopped it, run it again with \`sandbox: false\` (asks for the \`${permission}\` permission), or add the path to \`sandbox.write\` in the config.`,
  ].join(" ")
}

const homeCaches = [
  ".cache",
  ".bun",
  ".npm",
  ".cargo",
  ".rustup",
  "go",
  ".yarn",
  ".pnpm-store",
  ".local/share/pnpm",
  ".local/share/uv",
  ".deno",
  ".gradle",
  ".m2",
  ".ivy2",
  ".sbt",
  ".nuget",
  ".gem",
  ".bundle",
  ".cabal",
  ".stack",
  ".ghcup",
  ".opam",
  ".julia",
  ".pub-cache",
  ".node-gyp",
  ".swiftpm",
  ".cocoapods",
]
const macCaches = ["Library/Caches", "Library/pnpm", "Library/Developer/Xcode/DerivedData"]
const cacheVariables = [
  "XDG_CACHE_HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOCACHE",
  "GOMODCACHE",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
  "YARN_CACHE_FOLDER",
  "PNPM_HOME",
  "GRADLE_USER_HOME",
  "UV_CACHE_DIR",
  "PIP_CACHE_DIR",
  "DENO_DIR",
]

/** The usual package and build caches that exist. A variable that names the home folder (or above) is ignored. */
function caches(home: string, env: Env, temp: readonly string[]) {
  const named = cacheVariables.flatMap((name) => (env[name] ?? "").split(":")).filter((item) => path.isAbsolute(item))
  const darwin =
    process.platform === "darwin"
      ? [
          ...macCaches.map((item) => path.join(home, item)),
          // The per-user cache folder next to the per-user temp folder (/private/var/folders/xx/yyyy/T).
          ...temp.flatMap((item) =>
            /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(item) ? [path.join(item, "../C")] : [],
          ),
        ]
      : []
  // Most of them are missing: checking first spares resolving each one's folders.
  return [...homeCaches.map((item) => path.join(home, item)), ...darwin, ...named]
    .filter((item) => fs.existsSync(item))
    .map(real)
    .filter((item) => !inside(home, item))
}

/**
 * The temp folders that exist: the command's TMPDIR and this process's, ignored like a cache variable when one names
 * the home folder (or above), then /tmp and /var/tmp, which programs use whatever TMPDIR says.
 */
function temporary(home: string, env: Env) {
  const named = [env.TMPDIR, os.tmpdir()]
    .filter((item): item is string => item !== undefined && path.isAbsolute(item))
    .map(real)
    .filter((item) => !inside(home, item))
  return unique([...named, ...["/tmp", "/var/tmp"].map(real)].filter((item) => fs.existsSync(item)))
}

/**
 * openforge's credentials (the database holds them, also the copies a switch keeps) and service passwords. A command
 * outlives a switch, so the database files a switch writes later (the copy in the folder of the release it leaves,
 * and the temporary files of a copy and a restore) are named before they exist.
 */
function secrets(context: Context) {
  const database = context.database ?? path.join(context.data, "opencode.db")
  const files = (base: string) =>
    ["", "-wal", "-shm", "-journal", ".partial", ".restore"].map((suffix) => base + suffix)
  return [
    ...files(database),
    path.join(context.data, "auth.json"),
    ...matching(context.data, databaseFile),
    ...folders(path.join(context.data, "releases")).flatMap((folder) => [
      ...files(path.join(folder, path.basename(database))),
      ...matching(folder, databaseFile),
    ]),
    path.join(context.state, "service.json"),
    path.join(context.state, "service.json.pty-handoff"),
    ...matching(context.state, serviceFile),
    // The tool runner's token and the persistent terminals' tokens.
    path.join(context.state, "runner"),
    path.join(context.state, "pty"),
    path.join(context.config, "service.json"),
    ...matching(context.config, serviceFile),
  ].map(real)
}

const databaseFile = /\.db(-wal|-shm|-journal|\.partial|\.restore)?$/
const serviceFile = /^service.*\.json/

function git(directory: string) {
  const found = gitFolder(directory)
  if (!found) return []
  const common = text(path.join(found, "commondir"))?.trim()
  return unique([found, ...(common ? [path.resolve(found, common)] : [])].map(real))
}

/** The `.git` folder of the checkout `directory` is in; for a linked worktree or submodule, the folder `.git` names. */
function gitFolder(directory: string): string | undefined {
  const dotgit = path.join(directory, ".git")
  const stat = fs.statSync(dotgit, { throwIfNoEntry: false })
  if (stat?.isDirectory()) return dotgit
  if (stat?.isFile()) {
    const target = /^gitdir:\s*(.+?)\s*$/m.exec(text(dotgit) ?? "")?.[1]
    return target ? path.resolve(directory, target) : undefined
  }
  const parent = path.dirname(directory)
  return parent === directory ? undefined : gitFolder(parent)
}

function absolute(value: string, context: Context) {
  if (value === "~" || value === "$HOME") return context.home
  if (value.startsWith("~/")) return path.join(context.home, value.slice(2))
  if (value.startsWith("$HOME/")) return path.join(context.home, value.slice(6))
  return path.resolve(context.directory, value)
}

function shorten(file: string, home: string) {
  return inside(file, home) ? path.join("~", path.relative(home, file)) : file
}

function matching(directory: string, pattern: RegExp) {
  return entries(directory)
    .filter((entry) => pattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
}

function folders(directory: string) {
  return entries(directory)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
}

function unique(items: readonly string[]) {
  return [...new Set(items)]
}
