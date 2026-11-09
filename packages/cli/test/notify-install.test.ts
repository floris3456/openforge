import { describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Install } from "../src/notify/install"
import { isolatedEnv, stopLeftovers } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

// `openforge notify … --install` and `--uninstall`: the player of one route as a LaunchAgent or a systemd user unit.
// launchctl and systemctl are stand-ins first on the PATH the commands get; they note each call and keep which labels
// are loaded in files.

const LAUNCHCTL = `#!/bin/sh
echo "launchctl $*" >> "$STANDIN_LOG"
case "$1" in
  bootstrap) touch "$STANDIN_STATE/$(basename "$3" .plist)"; exit 0 ;;
  bootout) rm -f "$STANDIN_STATE/\${2##*/}"; exit 0 ;;
  print)
    [ -f "$STANDIN_STATE/\${2##*/}" ] || { echo "Could not find service" >&2; exit 113; }
    if [ -f "$STANDIN_STATE/crash" ]; then printf '\\tstate = not running\\n\\tlast exit code = 1\\n'
    else printf '\\tstate = running\\n\\tpid = 4242\\n'; fi
    exit 0 ;;
esac
exit 1
`

const SYSTEMCTL = `#!/bin/sh
echo "systemctl $*" >> "$STANDIN_LOG"
[ "$2" = is-active ] || exit 0
if [ -f "$STANDIN_STATE/crash" ]; then echo activating; exit 3; fi
echo active
`

const posix = test.skipIf(process.platform === "win32")

/** A home with openforge laid out as install.sh lays it out, and the stand-ins. */
async function machineAt(root: string, platform: "darwin" | "linux", options: { installed?: boolean } = {}) {
  const home = path.join(root, "home")
  const data = path.join(home, ".local", "share", "openforge")
  const standins = path.join(root, "standins")
  const state = path.join(root, "standin-state")
  await mkdir(standins, { recursive: true })
  await mkdir(state, { recursive: true })
  await writeFile(path.join(standins, "launchctl"), LAUNCHCTL, { mode: 0o755 })
  await writeFile(path.join(standins, "systemctl"), SYSTEMCTL, { mode: 0o755 })
  if (options.installed !== false) await layOut(home, data, ["0.0.20"], "0.0.20")
  const machine: Install.Machine = {
    platform,
    home,
    data,
    state: path.join(home, ".local", "state", "openforge"),
    config: path.join(home, ".config"),
    uid: 501,
    env: {
      PATH: `${standins}:/usr/bin:/bin`,
      HOME: home,
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OPENFORGE_SERVER_PASSWORD: "secret",
      STANDIN_LOG: path.join(root, "calls.log"),
      STANDIN_STATE: state,
    },
    settleMs: 0,
  }
  return {
    machine,
    calls: async () =>
      (await readFile(path.join(root, "calls.log"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replaceAll(home, "~")),
    clearCalls: () => rm(path.join(root, "calls.log"), { force: true }),
    crash: () => writeFile(path.join(state, "crash"), ""),
  }
}

async function layOut(home: string, data: string, versions: string[], current: string) {
  for (const version of versions) {
    await mkdir(path.join(data, "releases", version), { recursive: true })
    await writeFile(path.join(data, "releases", version, "openforge"), "#!/bin/sh\n", { mode: 0o755 })
  }
  await rm(path.join(data, "current"), { force: true })
  await symlink(path.join("releases", current), path.join(data, "current"))
  await mkdir(path.join(home, ".local", "bin"), { recursive: true })
  await rm(path.join(home, ".local", "bin", "openforge"), { force: true })
  await symlink(path.join(data, "current", "openforge"), path.join(home, ".local", "bin", "openforge"))
}

const via = (command: string): Install.Route => ({ type: "via", command: command.split(" ") })
const player = (route: Install.Route, overrides: Partial<Install.Player> = {}): Install.Player => ({
  route,
  desktop: false,
  volume: 0.4,
  verbose: false,
  ...overrides,
})

describe("names", () => {
  test("each route has a readable name of its own, the same each time", () => {
    expect(Install.slug({ type: "local" })).toBe("local")
    expect(Install.slug({ type: "ssh", target: "me@MacBook.local" })).toBe("ssh-me-macbook-local")
    expect(Install.slug(via("ocp run"))).toBe("via-ocp-run")
    expect(Install.slug({ type: "ssh", target: "ocp" })).not.toBe(Install.slug(via("ocp")))
    expect(Install.slug(via("ocp run"))).toBe(Install.slug(via("ocp run")))
  })

  test("a long route is cut and keeps a short hash, so two long routes stay apart", () => {
    expect(Install.slug(via("ssh cachyos docker exec -i -u bliss ocp"))).toBe(
      "via-ssh-cachyos-docker-exec-i-u-bliss-ocp",
    )
    const long = via("ssh cachyos.example.net docker exec -i -u bliss devbox-theorysnap")
    const other = via("ssh cachyos.example.net docker exec -i -u bliss devbox-theorysnap2")
    expect(Install.slug(long)).toMatch(/^via-ssh-cachyos-example-net-docker-exec-[0-9a-f]{8}$/)
    expect(Install.slug(long).length).toBeLessThanOrEqual(48)
    expect(Install.slug(long)).not.toBe(Install.slug(other))
    expect(Install.slug(long)).toBe(
      Install.slug(via("ssh cachyos.example.net docker exec -i -u bliss devbox-theorysnap")),
    )
  })

  test("a LaunchAgent on macOS, a systemd user unit on Linux, each with its log", () => {
    const base = { home: "/h", data: "/h/.local/share/openforge", uid: 501, env: {} }
    const mac = Install.names(
      { ...base, platform: "darwin", state: "/h/.local/state/openforge", config: "/h/.config" },
      via("ocp run"),
    )
    expect(mac).toEqual({
      name: "io.github.floris3456.openforge.notify.via-ocp-run",
      file: "/h/Library/LaunchAgents/io.github.floris3456.openforge.notify.via-ocp-run.plist",
      log: "/h/Library/Logs/openforge/notify-via-ocp-run.log",
    })
    const linux = Install.names(
      { ...base, platform: "linux", state: "/x/state/openforge", config: "/x/config" },
      via("ocp run"),
    )
    expect(linux).toEqual({
      name: "openforge-notify-via-ocp-run",
      file: "/x/config/systemd/user/openforge-notify-via-ocp-run.service",
      log: "/x/state/openforge/notify-via-ocp-run.log",
    })
  })

  test("the remove command names the route as typed, quoted for the shell", () => {
    expect(Install.uninstallCommand({ type: "local" })).toBe("openforge notify --uninstall")
    expect(Install.uninstallCommand({ type: "ssh", target: "me@mac" })).toBe("openforge notify me@mac --uninstall")
    expect(Install.uninstallCommand(via("ssh cachyos docker exec -i -u bliss ocp"))).toBe(
      "openforge notify --via 'ssh cachyos docker exec -i -u bliss ocp' --uninstall",
    )
  })
})

describe("the service's file", () => {
  posix(
    "the LaunchAgent runs the stable link with the player's flags, the PATH and folders only, and restarts",
    async () => {
      await using dir = await tmpdir()
      const at = await machineAt(dir.path, "darwin")
      const home = at.machine.home
      const text = Install.plist(
        at.machine,
        player(via("ssh cachyos docker exec -i -u bliss ocp"), { desktop: true, volume: 0.25, verbose: true }),
      )
      const name = `io.github.floris3456.openforge.notify.${Install.slug(via("ssh cachyos docker exec -i -u bliss ocp"))}`
      const log = `${home}/Library/Logs/openforge/notify-${name.split(".").at(-1)}.log`
      expect(text).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${home}/.local/bin/openforge</string>
    <string>notify</string>
    <string>--via</string>
    <string>ssh cachyos docker exec -i -u bliss ocp</string>
    <string>--desktop</string>
    <string>--volume=0.25</string>
    <string>--verbose</string>
    <string>--installed</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${at.machine.env.PATH}</string>
    <key>HOME</key><string>${home}</string>
  </dict>
  <key>WorkingDirectory</key><string>${home}</string>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`)
    },
  )

  test("text in the LaunchAgent is escaped for XML", () => {
    const text = Install.plist(
      {
        platform: "darwin",
        home: "/h",
        data: "/d",
        state: "/s",
        config: "/c",
        uid: 501,
        env: { PATH: "/a&b:/<c>" },
      },
      player({ type: "ssh", target: "o'neil@mac" }),
    )
    expect(text).toContain("<key>PATH</key><string>/a&amp;b:/&lt;c&gt;</string>")
    expect(text).toContain("<string>o&apos;neil@mac</string>")
  })

  test("the systemd unit runs the stable link with the player's flags, the PATH and folders only, and restarts", () => {
    const machine: Install.Machine = {
      platform: "linux",
      home: "/home/me",
      data: "/home/me/.local/share/openforge",
      state: "/home/me/.local/state/openforge",
      config: "/home/me/.config",
      uid: 1000,
      env: {
        PATH: "/home/me/.local/bin:/usr/bin",
        HOME: "/home/me",
        XDG_STATE_HOME: "/home/me/.local/state",
        SSH_AUTH_SOCK: "/run/user/1000/ssh",
        DISPLAY: ":0",
      },
    }
    expect(Install.unit(machine, player(via("ocp run")))).toBe(`[Unit]
Description=openforge notify: plays the notification sounds of ocp run
StartLimitIntervalSec=0

[Service]
ExecStart="/home/me/.local/bin/openforge" "notify" "--via" "ocp run" "--volume=0.4" "--installed"
Environment="PATH=/home/me/.local/bin:/usr/bin"
Environment="HOME=/home/me"
Environment="XDG_STATE_HOME=/home/me/.local/state"
WorkingDirectory=/home/me
StandardOutput=append:/home/me/.local/state/openforge/notify-via-ocp-run.log
StandardError=append:/home/me/.local/state/openforge/notify-via-ocp-run.log
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`)
  })

  test("the systemd unit keeps %, $, quotes and backslashes as they are", () => {
    const machine: Install.Machine = {
      platform: "linux",
      home: "/h",
      data: "/d",
      state: "/s",
      config: "/c",
      uid: 1000,
      env: { PATH: "/a%b:/c$d" },
    }
    const text = Install.unit(machine, player(via(`run "x" \\y $HOME 100%`)))
    expect(text).toContain(`"--via" "run \\"x\\" \\\\y $$HOME 100%%"`)
    expect(text).toContain(`Environment="PATH=/a%%b:/c$d"`)
  })
})

describe("installing and removing", () => {
  posix("on macOS: bootstrapped in the user's GUI domain, checked, replaced in place, removed", async () => {
    await using dir = await tmpdir()
    const at = await machineAt(dir.path, "darwin")
    const route = { type: "ssh" as const, target: "me@devbox" }
    const named = Install.names(at.machine, route)
    const domain = `gui/501/${named.name}`
    const file = named.file.replace(at.machine.home, "~")

    const first = await Install.install(at.machine, player(route))
    expect(first).toEqual({ ...named, running: true })
    expect(await at.calls()).toEqual([
      `launchctl print ${domain}`,
      `launchctl bootstrap gui/501 ${file}`,
      `launchctl print ${domain}`,
    ])
    expect(await Bun.file(named.file).text()).toBe(Install.plist(at.machine, player(route)))
    expect(await readdir(path.dirname(named.log))).toEqual([])

    await at.clearCalls()
    await Install.install(at.machine, player(route, { verbose: true }))
    expect(await at.calls()).toEqual([
      `launchctl print ${domain}`,
      `launchctl bootout ${domain}`,
      `launchctl print ${domain}`,
      `launchctl bootstrap gui/501 ${file}`,
      `launchctl print ${domain}`,
    ])
    expect(await Install.list(at.machine)).toEqual([named.file])
    expect(await Bun.file(named.file).text()).toContain("<string>--verbose</string>")

    await at.clearCalls()
    expect(await Install.uninstall(at.machine, route)).toBe(true)
    expect(await at.calls()).toEqual([
      `launchctl print ${domain}`,
      `launchctl print ${domain}`,
      `launchctl bootout ${domain}`,
      `launchctl print ${domain}`,
    ])
    expect(await Bun.file(named.file).exists()).toBe(false)
  })

  posix("on Linux: enabled and started, checked, stopped before it is rewritten, removed", async () => {
    await using dir = await tmpdir()
    const at = await machineAt(dir.path, "linux")
    const route = via("ocp run")
    const named = Install.names(at.machine, route)
    const unit = `${named.name}.service`

    expect(await Install.install(at.machine, player(route))).toEqual({ ...named, running: true })
    expect(await at.calls()).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${unit}`,
      `systemctl --user is-active ${unit}`,
    ])
    expect(await Bun.file(named.file).text()).toBe(Install.unit(at.machine, player(route)))

    await at.clearCalls()
    await Install.install(at.machine, player(route, { desktop: true }))
    expect(await at.calls()).toEqual([
      `systemctl --user disable --now ${unit}`,
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${unit}`,
      `systemctl --user is-active ${unit}`,
    ])
    expect(await Install.list(at.machine)).toEqual([named.file])
    expect(await Bun.file(named.file).text()).toContain(`"--desktop"`)

    await at.clearCalls()
    expect(await Install.uninstall(at.machine, route)).toBe(true)
    expect(await at.calls()).toEqual([`systemctl --user disable --now ${unit}`, "systemctl --user daemon-reload"])
    expect(await Bun.file(named.file).exists()).toBe(false)
  })

  posix("removing a player that is not installed changes nothing", async () => {
    await using dir = await tmpdir()
    for (const platform of ["darwin", "linux"] as const) {
      const at = await machineAt(path.join(dir.path, platform), platform)
      expect(await Install.uninstall(at.machine, { type: "local" })).toBe(false)
      expect((await at.calls()).filter((call) => !call.startsWith("launchctl print"))).toEqual([])
    }
  })

  posix("a player that does not run is reported with why and the end of its log", async () => {
    await using dir = await tmpdir()
    for (const platform of ["darwin", "linux"] as const) {
      const at = await machineAt(path.join(dir.path, platform), platform)
      await at.crash()
      const named = Install.names(at.machine, { type: "local" })
      await mkdir(path.dirname(named.log), { recursive: true })
      await writeFile(named.log, `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\n`)
      const result = await Install.install(at.machine, player({ type: "local" }))
      expect(result).toEqual({
        ...named,
        running: false,
        why:
          platform === "darwin"
            ? "launchd reports state not running, last exit code 1"
            : "systemd reports it activating",
        tail: Array.from({ length: 20 }, (_, i) => `line ${i + 10}`).join("\n"),
      })
    }
  })

  posix("removing every player takes only the players", async () => {
    await using dir = await tmpdir()
    for (const platform of ["darwin", "linux"] as const) {
      const at = await machineAt(path.join(dir.path, platform), platform)
      const routes: Install.Route[] = [{ type: "local" }, { type: "ssh", target: "a" }, via("ocp run")]
      for (const route of routes) await Install.install(at.machine, player(route))
      const folder = path.dirname(Install.names(at.machine, { type: "local" }).file)
      await writeFile(path.join(folder, platform === "darwin" ? "com.example.other.plist" : "other.service"), "")
      await at.clearCalls()
      expect((await Install.uninstallAll(at.machine)).sort()).toEqual(
        routes.map((route) => Install.names(at.machine, route).file).sort(),
      )
      expect(await readdir(folder)).toEqual([platform === "darwin" ? "com.example.other.plist" : "other.service"])
      const calls = await at.calls()
      for (const route of routes) {
        const name = Install.names(at.machine, route).name
        expect(calls).toContain(
          platform === "darwin"
            ? `launchctl bootout gui/501/${name}`
            : `systemctl --user disable --now ${name}.service`,
        )
      }
    }
  })
})

describe("the install it runs", () => {
  posix("only openforge installed with install.sh: the stable link to <data>/current", async () => {
    await using dir = await tmpdir()
    const at = await machineAt(dir.path, "linux", { installed: false })
    const link = path.join(at.machine.home, ".local", "bin", "openforge")
    expect(await Install.notInstalled(at.machine)).toContain("Install openforge with install.sh first")

    await mkdir(path.dirname(link), { recursive: true })
    await writeFile(path.join(dir.path, "worktree-build"), "#!/bin/sh\n", { mode: 0o755 })
    await symlink(path.join(dir.path, "worktree-build"), link)
    expect(await Install.notInstalled(at.machine)).toContain(
      `${link} must link to ${path.join(at.machine.data, "current", "openforge")}`,
    )

    await layOut(at.machine.home, at.machine.data, ["0.0.20"], "0.0.20")
    expect(await Install.notInstalled(at.machine)).toBeUndefined()
    expect(Install.args(player({ type: "local" }))[0]).toBe("notify")
    expect(Install.plist({ ...at.machine, platform: "darwin" }, player({ type: "local" }))).toContain(
      `<string>${link}</string>`,
    )
  })

  posix("an installed player learns when <data>/current points at another release", async () => {
    await using dir = await tmpdir()
    const at = await machineAt(dir.path, "linux")
    const data = at.machine.data
    await layOut(at.machine.home, data, ["0.0.20", "0.0.21"], "0.0.20")
    const link = path.join(at.machine.home, ".local", "bin", "openforge")
    const running = path.join(data, "releases", "0.0.20", "openforge")
    expect(await Install.upgraded(data, link)).toBeUndefined()
    expect(await Install.upgraded(data, running)).toBeUndefined()

    await layOut(at.machine.home, data, [], "0.0.21")
    expect(await Install.upgraded(data, running)).toBe("0.0.21")
    // Started again through the link, it runs the new release.
    expect(await Install.upgraded(data, link)).toBeUndefined()

    // current gone (openforge uninstalled), a release without its binary, a binary outside the layout: keep running.
    await rm(path.join(data, "current"))
    expect(await Install.upgraded(data, running)).toBeUndefined()
    await mkdir(path.join(data, "releases", "0.0.22"))
    await symlink(path.join("releases", "0.0.22"), path.join(data, "current"))
    expect(await Install.upgraded(data, running)).toBeUndefined()
    await rm(path.join(data, "current"))
    await symlink(path.join("releases", "0.0.21"), path.join(data, "current"))
    expect(await Install.upgraded(data, process.execPath)).toBeUndefined()
  })
})

describe("the command", () => {
  const cli = path.join(import.meta.dir, "../src/index.ts")

  async function run(root: string, args: string[], extra: Record<string, string> = {}) {
    const at = await machineAt(root, "linux", { installed: false })
    const env = isolatedEnv(root, {
      ...extra,
      PATH: `${path.join(root, "standins")}:${isolatedEnv(root).PATH}`,
      STANDIN_LOG: at.machine.env.STANDIN_LOG!,
      STANDIN_STATE: at.machine.env.STANDIN_STATE!,
    })
    const child = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stopLeftovers(root)).toEqual([])
    return { stdout, stderr, code, calls: at.calls }
  }

  test.skipIf(process.platform !== "linux")(
    "--install writes, starts and checks the unit and prints how to remove it; --uninstall removes it",
    async () => {
      await using dir = await tmpdir()
      await layOut(dir.path, path.join(dir.path, "data", "openforge"), ["0.0.20"], "0.0.20")
      const installed = await run(dir.path, ["notify", "--via", "ocp  run", "--volume", "0.3", "--install"])
      expect(installed.stderr).toBe("")
      expect(installed.code).toBe(0)
      const unit = path.join(dir.path, "xdg-config", "systemd", "user", "openforge-notify-via-ocp-run.service")
      const log = path.join(dir.path, "state", "openforge", "notify-via-ocp-run.log")
      expect(installed.stdout).toBe(
        [
          "The player for ocp run runs as a systemd user unit: it starts at login and again when it stops.",
          "  Name    openforge-notify-via-ocp-run",
          `  File    ${unit}`,
          `  Log     ${log}`,
          "  Remove  openforge notify --via 'ocp run' --uninstall",
          "",
        ].join("\n"),
      )
      const text = await Bun.file(unit).text()
      expect(text).toContain(
        `ExecStart="${dir.path}/.local/bin/openforge" "notify" "--via" "ocp run" "--volume=0.3" "--installed"`,
      )
      expect(text).toContain(`Environment="XDG_STATE_HOME=${dir.path}/state"`)
      expect(text).not.toContain("STANDIN")
      expect(await installed.calls()).toEqual([
        "systemctl --user daemon-reload",
        "systemctl --user enable --now openforge-notify-via-ocp-run.service",
        "systemctl --user is-active openforge-notify-via-ocp-run.service",
      ])

      const removed = await run(dir.path, ["notify", "--via", "ocp run", "--uninstall"])
      expect(removed.code).toBe(0)
      expect(removed.stdout).toBe(`Removed the player for ocp run: openforge-notify-via-ocp-run, ${unit}.\n`)
      expect(await Bun.file(unit).exists()).toBe(false)

      const none = await run(dir.path, ["notify", "--via", "ocp run", "--uninstall"])
      expect(none.code).toBe(0)
      expect(none.stdout).toBe(`No player is installed for ocp run (${unit} does not exist).\n`)
    },
  )

  test.skipIf(process.platform !== "linux")("--install exits non-zero when the player does not run", async () => {
    await using dir = await tmpdir()
    await layOut(dir.path, path.join(dir.path, "data", "openforge"), ["0.0.20"], "0.0.20")
    await mkdir(path.join(dir.path, "standin-state"), { recursive: true })
    await writeFile(path.join(dir.path, "standin-state", "crash"), "")
    await mkdir(path.join(dir.path, "state", "openforge"), { recursive: true })
    await writeFile(path.join(dir.path, "state", "openforge", "notify-local.log"), "Error: no sound\n")
    const result = await run(dir.path, ["notify", "--install"])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toStartWith(
      "The player for this machine is installed as a systemd user unit but does not run: systemd reports it activating.\n",
    )
    expect(result.stderr).toEndWith(
      "  Remove  openforge notify --uninstall\nThe last lines of its log:\nError: no sound\n",
    )
  })

  test.skipIf(process.platform === "win32")("--install refuses what it can't do, and installs nothing", async () => {
    await using dir = await tmpdir()
    const cases: [string[], string][] = [
      [["--install", "--uninstall"], "Give --install or --uninstall, not both"],
      [["--install", "--test"], "--install can't be combined with --test"],
      [["--uninstall", "--relay"], "--uninstall can't be combined with --relay"],
      [["--install", "--sound-command", "true"], "--install can't be combined with --sound-command"],
      [["--install"], "Install openforge with install.sh first"],
    ]
    const results = await Promise.all(
      cases.map(([args], index) => run(path.join(dir.path, String(index)), ["notify", ...args])),
    )
    results.forEach((result, index) => {
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(cases[index]![1])
    })
    for (const index of cases.keys()) {
      expect(await readdir(path.join(dir.path, String(index), "xdg-config", "systemd")).catch(() => [])).toEqual([])
      expect(await results[index]!.calls()).toEqual([])
    }
  })

  test.skipIf(process.platform !== "linux")("openforge uninstall also removes every installed player", async () => {
    await using dir = await tmpdir()
    const folder = path.join(dir.path, "xdg-config", "systemd", "user")
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, "openforge-notify-local.service"), "")
    await writeFile(path.join(folder, "openforge-notify-via-ocp-run.service"), "")
    await writeFile(path.join(folder, "other.service"), "")
    const result = await run(dir.path, ["uninstall", "--force"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `Stop and remove notification player: ${path.join(folder, "openforge-notify-local.service")}`,
    )
    expect(await readdir(folder)).toEqual(["other.service"])
    expect(await result.calls()).toEqual([
      "systemctl --user disable --now openforge-notify-local.service",
      "systemctl --user disable --now openforge-notify-via-ocp-run.service",
      "systemctl --user daemon-reload",
    ])
  })
})
