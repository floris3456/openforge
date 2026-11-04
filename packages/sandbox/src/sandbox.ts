export * as Sandbox from "./sandbox.js"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConfigSandbox } from "@opencode/schema/config/sandbox"
import { landlock, seccomp } from "#native"
import { Landlock } from "./landlock.js"
import { Seatbelt } from "./seatbelt.js"

// Which shell commands may write and read where, and how a command is started inside that. Linux confines with
// Landlock and seccomp in `openforge sandbox-exec`; macOS runs `/usr/bin/sandbox-exec` with a Seatbelt profile.
// It guards against mistakes, not against a hostile model: local services, sockets and signals are not blocked.

export type Mode = ConfigSandbox.Mode
/** The `sandbox` settings of the config and of an agent. */
export type Settings = ConfigSandbox.Info
export const merge = ConfigSandbox.merge
/** The permission a command needs to run outside the sandbox (`sandbox: false`). */
export const permission = "unsandboxed"

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
  /** A temp folder of the command's own. */
  readonly tmp?: string
  /** The command's environment: its TMPDIR and cache variables add writable folders. Default: this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
}

/** A concrete policy: resolved absolute paths. Plain data, so it can travel to the tool runner as JSON. */
export interface Policy {
  readonly mode: Mode
  readonly network: boolean
  readonly required: boolean
  readonly write: readonly string[]
  readonly denyRead: readonly string[]
  readonly platform: NodeJS.Platform
  readonly home: string
}

export type Availability = { readonly ok: true; readonly landlock?: number } | { readonly ok: false; readonly reason: string }

export type Wrapped =
  | {
      readonly type: "run"
      readonly argv: string[]
      readonly sandboxed: boolean
      /** Set on the first command of this process that runs unsandboxed because the machine can't sandbox. */
      readonly warning?: string
    }
  | { readonly type: "refuse"; readonly reason: string }

export function resolve(settings: Settings | undefined, context: Context): Policy {
  const platform = context.platform ?? process.platform
  const env = context.env ?? process.env
  const mode = settings?.mode ?? "write"
  const base = {
    mode,
    network: settings?.network ?? true,
    required: settings?.required ?? false,
    platform,
    home: real(context.home),
  }
  if (mode === "off") return { ...base, write: [], denyRead: [] }
  const temp = temporary(context, env)
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
          ...caches(platform, base.home, env, temp),
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
  return (availability ??= detect(process.platform))
}

export function detect(
  platform: NodeJS.Platform,
  probe = { landlock, seccomp, seatbelt: () => fs.existsSync("/usr/bin/sandbox-exec") },
): Availability {
  if (platform === "darwin")
    return probe.seatbelt() ? { ok: true } : { ok: false, reason: "/usr/bin/sandbox-exec is missing" }
  if (platform !== "linux") return { ok: false, reason: `there is no sandbox on ${platform}` }
  const abi = probe.landlock()
  if (abi === 0) return { ok: false, reason: "this kernel has no Landlock" }
  if (abi < 2) return { ok: false, reason: `this kernel's Landlock (ABI ${abi}) is too old` }
  if (!probe.seccomp()) return { ok: false, reason: "this kernel has no seccomp filters" }
  return { ok: true, landlock: abi }
}

let warned = false

/**
 * The argv that runs `argv` under `policy`. `self` starts this openforge (`selfCommand()`), whose hidden
 * `sandbox-exec` command confines itself on Linux. When the machine can't sandbox, the command runs unsandboxed, or
 * is refused when the policy requires the sandbox.
 */
export function wrap(
  policy: Policy,
  argv: readonly string[],
  self: readonly string[],
  machine: Availability = available(),
): Wrapped {
  if (policy.mode === "off") return { type: "run", argv: [...argv], sandboxed: false }
  if (!machine.ok) {
    const reason = `This machine can't sandbox commands: ${machine.reason}.`
    if (policy.required) return { type: "refuse", reason: `${reason} The command was not run, as sandbox.required is set.` }
    const first = !warned
    warned = true
    return {
      type: "run",
      argv: [...argv],
      sandboxed: false,
      ...(first ? { warning: `${reason} Commands run unsandboxed.` } : {}),
    }
  }
  const confined = { write: policy.write, deny: policy.denyRead, network: policy.network }
  if (policy.platform === "darwin")
    return { type: "run", argv: ["/usr/bin/sandbox-exec", "-p", Seatbelt.profile(confined), ...argv], sandboxed: true }
  return { type: "run", argv: [...self, "sandbox-exec", Landlock.encode(confined), "--", ...argv], sandboxed: true }
}

/** The note added to the result of a sandboxed command that failed: where it may write, and how to go outside. */
export function note(policy: Policy) {
  if (policy.mode === "off") return undefined
  const places = policy.write.map((item) => shorten(item, policy.home)).join(", ")
  return [
    `This command ran in the sandbox, which lets it write only to ${places}${policy.network ? "" : ", and gives it no network"}.`,
    "If the sandbox stopped it, run it again with `sandbox: false` (asks for the `unsandboxed` permission), or add the path to `sandbox.write` in the config.",
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
function caches(platform: NodeJS.Platform, home: string, env: Context["env"] & {}, temp: readonly string[]) {
  const named = cacheVariables.flatMap((name) => (env[name] ?? "").split(":")).filter((item) => path.isAbsolute(item))
  const darwin =
    platform === "darwin"
      ? [
          ...macCaches.map((item) => path.join(home, item)),
          // The per-user cache folder next to the per-user temp folder (/private/var/folders/xx/yyyy/T).
          ...temp.flatMap((item) => (/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(item) ? [path.join(item, "../C")] : [])),
        ]
      : []
  return [...homeCaches.map((item) => path.join(home, item)), ...darwin, ...named]
    .map(real)
    .filter((item) => fs.existsSync(item) && !inside(home, item))
}

/** The temp folders that exist: the command's own, its TMPDIR, this process's, /tmp and /var/tmp. */
function temporary(context: Context, env: Context["env"] & {}) {
  const home = real(context.home)
  const named = [context.tmp, env.TMPDIR, os.tmpdir()]
    .filter((item): item is string => item !== undefined && path.isAbsolute(item))
    .map(real)
    .filter((item) => !inside(home, item))
  return unique([...named, ...["/tmp", "/var/tmp"].map(real)].filter((item) => fs.existsSync(item)))
}

/** openforge's credentials (the database holds them, also the copies a switch keeps) and service passwords. */
function secrets(context: Context) {
  const database = context.database ?? path.join(context.data, "opencode.db")
  const releases = path.join(context.data, "releases")
  return [
    ...["", "-wal", "-shm", "-journal"].map((suffix) => database + suffix),
    path.join(context.data, "auth.json"),
    ...matching(context.data, databaseFile),
    ...folders(releases).flatMap((folder) => matching(folder, databaseFile)),
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

const databaseFile = /\.db(-wal|-shm|-journal|\.restore)?$/
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

/** The real path; for a path that doesn't exist yet, its deepest existing folder's real path plus the rest. */
function real(file: string): string {
  const resolved = path.resolve(file)
  const found = attempt(() => fs.realpathSync.native(resolved))
  if (found !== undefined) return found
  const parent = path.dirname(resolved)
  return parent === resolved ? resolved : path.join(real(parent), path.basename(resolved))
}

function inside(child: string, parent: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
}

function shorten(file: string, home: string) {
  if (file === home) return "~"
  return inside(file, home) ? path.join("~", path.relative(home, file)) : file
}

function matching(directory: string, pattern: RegExp) {
  return (attempt(() => fs.readdirSync(directory)) ?? []).filter((name) => pattern.test(name)).map((name) => path.join(directory, name))
}

function folders(directory: string) {
  return (attempt(() => fs.readdirSync(directory, { withFileTypes: true })) ?? [])
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
}

function text(file: string) {
  return attempt(() => fs.readFileSync(file, "utf8"))
}

function unique(items: readonly string[]) {
  return [...new Set(items)]
}

function attempt<T>(fn: () => T) {
  try {
    return fn()
  } catch {
    return undefined
  }
}
