export * as SoundOutput from "./sound-output"

import { readdirSync, readFileSync, statSync } from "node:fs"

// openforge: whether this machine has anywhere to play a sound. On Linux OpenTUI's audio (miniaudio) tries a PulseAudio
// server, then ALSA; with neither a server nor a sound card, as in a container, libasound prints some 35 lines of
// errors to stderr, which is the terminal a TUI draws on. There the audio is never opened.

/** What `available` looks at; the machine's own unless a test gives another. */
export interface Probe {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly uid: number | undefined
  /** Whether something (a socket, a file) is at the path. */
  readonly exists: (path: string) => boolean
  /** The file's text, undefined when it can't be read. */
  readonly read: (path: string) => string | undefined
  /** The folder's entries, none when it can't be read. */
  readonly list: (path: string) => readonly string[]
}

/**
 * Whether a sound can play here: always outside Linux; on Linux with a PulseAudio server (PipeWire runs one too), named
 * by `PULSE_SERVER` or at its socket, or an ALSA sound card.
 */
export function available(probe: Probe = system()) {
  if (probe.platform !== "linux") return true
  if (probe.env.PULSE_SERVER) return true
  const runtime = [probe.env.XDG_RUNTIME_DIR, probe.uid === undefined ? undefined : `/run/user/${probe.uid}`]
  const sockets = [...runtime.flatMap((dir) => (dir ? [`${dir}/pulse/native`] : [])), "/run/pulse/native"]
  if (sockets.some(probe.exists)) return true
  const cards = probe.read("/proc/asound/cards")?.trim()
  if (cards && !cards.includes("no soundcards")) return true
  return probe.list("/dev/snd").some((name) => name.startsWith("pcm"))
}

function system(): Probe {
  return {
    platform: process.platform,
    env: process.env,
    uid: process.getuid?.(),
    exists: (path) => unless(() => statSync(path, { throwIfNoEntry: false }) !== undefined, false),
    read: (path) => unless(() => readFileSync(path, "utf8"), undefined),
    list: (path) => unless(() => readdirSync(path), []),
  }
}

/** What `run` answers, or `fallback` when it throws: a path that isn't there or may not be read counts as none. */
function unless<T>(run: () => T, fallback: T) {
  try {
    return run()
  } catch {
    return fallback
  }
}
