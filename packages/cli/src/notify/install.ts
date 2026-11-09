export * as Install from "./install"

import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Product } from "@opencode/schema/product"

// `openforge notify … --install`: keeps one player per route running as a service of this machine, a LaunchAgent on
// macOS or a systemd user unit on Linux, started at login and again whenever it stops. The service runs the stable
// link `~/.local/bin/openforge`, so it follows the release `<data>/current` points at.

/** How often an installed player checks whether `<data>/current` still points at the release it runs from. */
export const UPGRADE_CHECK_MS = 60_000
/** How long a started player gets before `--install` checks that it runs. */
export const SETTLE_MS = 2_000
/** launchd waits this long before it starts a stopped player again (its default is 10 s). */
export const THROTTLE_S = 10
/** systemd waits this long before it starts a stopped player again. */
export const RESTART_S = 5
const SLUG_MAX = 48
const LABEL_PREFIX = `${Product.preferences.replace(/\.managed$/, "")}.notify.`
const UNIT_PREFIX = `${Product.binary}-notify-`
// The installing shell's folders, so the service finds the same install, service and settings; paths, never secrets.
const CARRIED = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]

export type Route =
  | { readonly type: "local" }
  | { readonly type: "ssh"; readonly target: string }
  | { readonly type: "via"; readonly command: readonly string[] }

export type Machine = {
  readonly platform: "darwin" | "linux"
  readonly home: string
  /** `<XDG data>/openforge`, the install layout's folder. */
  readonly data: string
  /** `<XDG state>/openforge`. */
  readonly state: string
  /** The XDG config base folder (`~/.config`), where systemd looks for user units. */
  readonly config: string
  readonly uid: number
  /** The environment of the shell that ran `--install`; launchctl and systemctl are found on its PATH. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** SETTLE_MS unless a test shortens it. */
  readonly settleMs?: number
}

export type Player = {
  readonly route: Route
  readonly desktop: boolean
  readonly volume: number
  readonly verbose: boolean
}

/** This machine, as the CLI's global folders and environment see it; none where no player runs as a service. */
export function machine(global: { readonly home: string; readonly data: string; readonly state: string }) {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined
  return {
    platform: process.platform,
    home: global.home,
    data: global.data,
    state: global.state,
    // Where systemd looks for user units; the CLI's own config folder may be moved with OPENCODE_CONFIG_DIR.
    config: process.env.XDG_CONFIG_HOME || path.join(global.home, ".config"),
    uid: process.getuid?.() ?? 0,
    env: process.env,
  } satisfies Machine
}

/** Readable and the same for the same route: `local`, `ssh-<target>` or `via-<command>`, with a hash when long. */
export function slug(route: Route) {
  if (route.type === "local") return "local"
  const text = route.type === "ssh" ? route.target : route.command.join(" ")
  const base = `${route.type}-${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`
  if (base.length <= SLUG_MAX) return base
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8)
  return `${base.slice(0, SLUG_MAX - 9).replace(/-+$/, "")}-${hash}`
}

/** What the player of `route` is called, where its file is and where it writes its output. */
export function names(machine: Machine, route: Route) {
  const id = slug(route)
  if (machine.platform === "darwin") {
    const name = `${LABEL_PREFIX}${id}`
    return {
      name,
      file: path.join(machine.home, "Library", "LaunchAgents", `${name}.plist`),
      log: path.join(machine.home, "Library", "Logs", Product.folder, `notify-${id}.log`),
    }
  }
  const name = `${UNIT_PREFIX}${id}`
  return {
    name,
    file: path.join(machine.config, "systemd", "user", `${name}.service`),
    log: path.join(machine.state, `notify-${id}.log`),
  }
}

/** The stable link install.sh makes: `~/.local/bin/openforge -> <data>/current/openforge`. */
export function program(machine: Machine) {
  return path.join(machine.home, ".local", "bin", Product.binary)
}

/** Why openforge here is not installed the way the service needs it, or nothing when it is. */
export async function notInstalled(machine: Machine) {
  const link = program(machine)
  const expected = path.join(machine.data, "current", Product.binary)
  const target = await readlink(link).catch(() => undefined)
  const runs = await realpath(link).catch(() => undefined)
  if (target === expected && runs !== undefined) return undefined
  return `${Product.name} is not installed with install.sh here (${link} must link to ${expected}). A player that runs as a service needs that link, so it follows upgrades. Install ${Product.name} with install.sh first: curl -fsSL https://github.com/${Product.repository}/releases/latest/download/install.sh | sh`
}

/** The player's arguments after the program, as given to `--install`, with `--installed`. */
export function args(player: Player) {
  return [
    "notify",
    ...(player.route.type === "ssh" ? [player.route.target] : []),
    ...(player.route.type === "via" ? ["--via", player.route.command.join(" ")] : []),
    ...(player.desktop ? ["--desktop"] : []),
    `--volume=${player.volume}`,
    ...(player.verbose ? ["--verbose"] : []),
    "--installed",
  ]
}

/** The environment the service gets: the installing shell's PATH and folders, nothing else. */
export function environment(machine: Machine) {
  return Object.fromEntries(
    ["PATH", ...CARRIED].flatMap((key) => {
      const value = machine.env[key]
      return value ? [[key, value] as const] : []
    }),
  )
}

export function plist(machine: Machine, player: Player) {
  const named = names(machine, player.route)
  const string = (value: string) => `<string>${xml(value)}</string>`
  const env = Object.entries(environment(machine))
    .map(([key, value]) => `    <key>${xml(key)}</key>${string(value)}`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(named.name)}
  <key>ProgramArguments</key>
  <array>
${[program(machine), ...args(player)].map((arg) => `    ${string(arg)}`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key>${string(machine.home)}
  <key>StandardOutPath</key>${string(named.log)}
  <key>StandardErrorPath</key>${string(named.log)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>${THROTTLE_S}</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`
}

export function unit(machine: Machine, player: Player) {
  const named = names(machine, player.route)
  const env = Object.entries(environment(machine))
    .map(([key, value]) => `Environment=${quote(`${key}=${value}`, false)}`)
    .join("\n")
  return `[Unit]
Description=${specifiers(`${Product.name} notify: plays the notification sounds of ${label(player.route)}`)}
StartLimitIntervalSec=0

[Service]
ExecStart=${[program(machine), ...args(player)].map((arg) => quote(arg, true)).join(" ")}
${env}
WorkingDirectory=${specifiers(machine.home)}
StandardOutput=append:${specifiers(named.log)}
StandardError=append:${specifiers(named.log)}
Restart=always
RestartSec=${RESTART_S}

[Install]
WantedBy=default.target
`
}

/** How the person who typed it names the route. */
export function label(route: Route) {
  if (route.type === "ssh") return route.target
  if (route.type === "via") return route.command.join(" ")
  return "this machine"
}

/** The command that removes the player of `route`. */
export function uninstallCommand(route: Route) {
  return [
    Product.binary,
    "notify",
    ...(route.type === "ssh" ? [shell(route.target)] : []),
    ...(route.type === "via" ? ["--via", shell(route.command.join(" "))] : []),
    "--uninstall",
  ].join(" ")
}

export type Installed = ReturnType<typeof names> & { readonly running: true }
export type NotRunning = ReturnType<typeof names> & {
  readonly running: false
  readonly why: string
  readonly tail: string
}

/** Installs the player, replacing the one of the same route, starts it and checks that it runs. */
export async function install(machine: Machine, player: Player): Promise<Installed | NotRunning> {
  const named = names(machine, player.route)
  await stop(machine, named)
  await mkdir(path.dirname(named.file), { recursive: true })
  await mkdir(path.dirname(named.log), { recursive: true })
  await writeFile(named.file, machine.platform === "darwin" ? plist(machine, player) : unit(machine, player))
  await start(machine, named)
  await Bun.sleep(machine.settleMs ?? SETTLE_MS)
  const why = await notRunning(machine, named)
  if (why === undefined) return { ...named, running: true }
  return { ...named, running: false, why, tail: await tail(named.log) }
}

/** Stops the player of `route` and removes its file; false when none was installed. */
export async function uninstall(machine: Machine, route: Route) {
  const named = names(machine, route)
  const present = await Bun.file(named.file).exists()
  const loaded = await isLoaded(machine, named)
  if (!present && !loaded) return false
  await stop(machine, named)
  await rm(named.file, { force: true })
  if (machine.platform === "linux") await run(machine, ["systemctl", "--user", "daemon-reload"])
  return true
}

/** The files of every installed player, whatever its route. */
export async function list(machine: Machine) {
  const folder = path.dirname(names(machine, { type: "local" }).file)
  const prefix = machine.platform === "darwin" ? LABEL_PREFIX : UNIT_PREFIX
  const suffix = machine.platform === "darwin" ? ".plist" : ".service"
  const entries = await readdir(folder).catch(() => [])
  return entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .map((entry) => path.join(folder, entry))
    .sort()
}

/** Stops and removes every installed player (`openforge uninstall`); returns their files. */
export async function uninstallAll(machine: Machine) {
  const files = await list(machine)
  for (const file of files) {
    const named = { name: path.basename(file, path.extname(file)), file }
    await stop(machine, named)
    await rm(file, { force: true })
  }
  if (files.length && machine.platform === "linux") await run(machine, ["systemctl", "--user", "daemon-reload"])
  return files
}

/**
 * For a player run by the service: the release `<data>/current` now points at, when that is not the one `executable`
 * runs from. Nothing when it is, when `current` is gone, or when `executable` is not a release of this layout.
 */
export async function upgraded(data: string, executable: string) {
  const releases = path.join(data, "releases")
  const own = await realpath(executable).catch(() => executable)
  if (path.dirname(path.dirname(own)) !== (await realpath(releases).catch(() => releases))) return undefined
  const current = await readlink(path.join(data, "current")).catch(() => undefined)
  if (current === undefined) return undefined
  const version = path.basename(current)
  if (version === path.basename(path.dirname(own))) return undefined
  if (!(await Bun.file(path.join(releases, version, Product.binary)).exists())) return undefined
  return version
}

type Named = { readonly name: string; readonly file: string }

function domain(machine: Machine) {
  return `gui/${machine.uid}`
}

async function start(machine: Machine, named: Named) {
  if (machine.platform === "darwin") {
    await run(machine, ["launchctl", "bootstrap", domain(machine), named.file], true)
    return
  }
  await run(machine, ["systemctl", "--user", "daemon-reload"], true)
  await run(machine, ["systemctl", "--user", "enable", "--now", `${named.name}.service`], true)
}

async function stop(machine: Machine, named: Named) {
  if (machine.platform === "linux") {
    if (await Bun.file(named.file).exists())
      await run(machine, ["systemctl", "--user", "disable", "--now", `${named.name}.service`])
    return
  }
  if (!(await isLoaded(machine, named))) return
  await run(machine, ["launchctl", "bootout", `${domain(machine)}/${named.name}`])
  // bootout returns before launchd has let go of the label; bootstrap fails until it has.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && (await isLoaded(machine, named))) await Bun.sleep(200)
}

async function isLoaded(machine: Machine, named: Named) {
  if (machine.platform === "linux") return false
  return (await run(machine, ["launchctl", "print", `${domain(machine)}/${named.name}`])).code === 0
}

async function notRunning(machine: Machine, named: Named) {
  if (machine.platform === "darwin") {
    const printed = await run(machine, ["launchctl", "print", `${domain(machine)}/${named.name}`])
    if (printed.code !== 0) return `launchd has no ${named.name}`
    if (/^\s*state = running$/m.test(printed.stdout)) return undefined
    const state = printed.stdout.match(/^\s*state = (.+)$/m)?.[1]
    const exit = printed.stdout.match(/^\s*last exit code = (.+)$/m)?.[1]
    return `launchd reports state ${state ?? "unknown"}${exit === undefined ? "" : `, last exit code ${exit}`}`
  }
  const active = await run(machine, ["systemctl", "--user", "is-active", `${named.name}.service`])
  if (active.stdout.trim() === "active") return undefined
  return `systemd reports it ${active.stdout.trim() || `unknown (systemctl exited with ${active.code})`}`
}

async function run(machine: Machine, command: string[], required = false) {
  // Found on the installing shell's PATH, as the person who ran --install would find it.
  const file = Bun.which(command[0], { PATH: machine.env.PATH ?? "" }) ?? command[0]
  const child = Bun.spawn([file, ...command.slice(1)], {
    env: { ...machine.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (required && code !== 0)
    throw new Error(`${command.join(" ")} exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)
  return { code, stdout }
}

async function tail(file: string) {
  const text = await readFile(file, "utf8").catch(() => "")
  return text.trimEnd().split("\n").slice(-20).join("\n")
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

// systemd reads % as a specifier in every setting, and $ as a variable in ExecStart.
function specifiers(value: string) {
  return value.replaceAll("%", "%%")
}

function quote(value: string, command: boolean) {
  const quoted = specifiers(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')
  return `"${command ? quoted.replaceAll("$", "$$$$") : quoted}"`
}

function shell(value: string) {
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
