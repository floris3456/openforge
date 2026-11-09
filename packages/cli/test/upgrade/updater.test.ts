import { NodeServices } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import type { UpgradeState } from "@opencode/client/promise"
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, Schedule } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { withEnsureTiming } from "../../../client/src/service-timing"
import { testEffect } from "../../../core/test/lib/effect"
import { ReleaseLayout } from "../../src/upgrade/layout"
import { ReleaseSwitch } from "../../src/upgrade/switch"
import { Updater } from "../../src/upgrade/updater"
import {
  fake,
  happened,
  history,
  keep,
  layer,
  migrations,
  paths,
  publish,
  releaseServer,
  root,
  target,
  writeMigrations,
  type Serve,
} from "./fixture/fixture"

const it = testEffect(NodeServices.layer)

type Releases = Record<string, Record<string, string | Uint8Array>>

const tool = (sessionID: string) => ({ sessionID, kind: "tool" as const, name: "webfetch" })

// openforge `from` (0.1.0) installed by install.sh and its service running; `releases` is what the fake GitHub
// serves.
const install = (
  options: {
    readonly releases?: Releases
    readonly latest?: string
    readonly policy?: string
    readonly from?: string
    readonly pause?: Duration.Duration
  } = {},
) =>
  Effect.gen(function* () {
    const directory = yield* root
    const dirs = paths(directory)
    const switching = yield* target(directory)
    const releases: Releases = { ...options.releases }
    const server = yield* releaseServer(releases, options.latest)
    const provide = Effect.provide(layer(directory))
    const from = options.from ?? "0.1.0"
    yield* Effect.promise(() => keep(switching.layout, from))
    yield* ReleaseLayout.point(switching.layout, from).pipe(provide)
    const started = yield* ReleaseSwitch.start(switching, from).pipe(provide)
    if (started.paused) yield* Effect.promise(() => fake(started.endpoint.url, "/api/experimental/service/resume"))
    yield* Effect.promise(() => fs.rm(history(directory), { force: true }))
    if (options.policy !== undefined)
      yield* Effect.promise(async () => {
        await fs.mkdir(dirs.config, { recursive: true })
        await fs.writeFile(path.join(dirs.config, "opencode.json"), options.policy ?? "")
      })
    const make = (version = "0.1.0", overrides: Partial<Updater.Options> = {}) =>
      Effect.gen(function* () {
        return yield* Updater.make({
          data: dirs.data,
          config: dirs.config,
          log: dirs.log,
          version,
          local: false,
          disabled: false,
          executable: yield* Effect.promise(() => fs.realpath(ReleaseLayout.binary(switching.layout, version))),
          platform: "linux-x64",
          base: server.url,
          database: switching.database,
          service: Effect.succeed(switching.service),
          serviceDisabled: Effect.succeed(false),
          timeout: switching.timeout,
          pause: options.pause,
          ...overrides,
        })
      }).pipe(provide)
    const states: UpgradeState[] = []
    const heard = new Set<{ readonly match: (state: UpgradeState) => boolean; readonly done: () => void }>()
    const notify = (state: UpgradeState) => {
      states.push(state)
      heard.forEach((listener) => (listener.match(state) ? listener.done() : undefined))
    }
    // Waits until the upgrade reports a state of this type, or one that matches.
    const reports = (expected: UpgradeState["type"] | ((state: UpgradeState) => boolean)) =>
      Effect.callback<void>((resume) => {
        const match = typeof expected === "string" ? (state: UpgradeState) => state.type === expected : expected
        if (states.some(match)) return resume(Effect.void)
        const listener = { match, done: () => resume(Effect.void) }
        heard.add(listener)
        return Effect.sync(() => heard.delete(listener))
      }).pipe(Effect.timeout("10 seconds"))
    const reported = Effect.gen(function* () {
      const endpoint = yield* Service.discover({ file: switching.service.file })
      if (!endpoint) return undefined
      const info = yield* Effect.promise(() =>
        fetch(new URL("/api/info", endpoint.url)).then((response) => response.json()),
      )
      return (info as { version: string }).version
    })
    return {
      directory,
      switching,
      url: started.endpoint.url,
      server,
      releases,
      provide,
      make,
      states,
      notify,
      reports,
      happened: Effect.promise(() => happened(directory)),
      reported,
      current: ReleaseLayout.current(switching.layout).pipe(provide),
      publish: (version: string, serve?: Serve) =>
        Effect.promise(async () => {
          releases[version] = await publish(directory, version, { serve })
        }),
      downloads: () => server.requests.filter((request) => request.endsWith(".tar.gz")),
    }
  })

describe("policy", () => {
  test("reads the update policy from JSONC config", () => {
    expect(Updater.decodePolicy('{ // preference\n "update": "notify",\n}')).toBe("notify")
    expect(Updater.decodePolicy('{ "update": "disable" }')).toBe("disable")
    expect(Updater.decodePolicy('{ "update": "auto" }')).toBe("auto")
    expect(Updater.decodePolicy('{ "update": "invalid" }')).toBeUndefined()
    expect(Updater.decodePolicy('{ "autoupdate": false }')).toBe("disable")
    expect(Updater.decodePolicy('{ "autoupdate": "notify" }')).toBe("notify")
    expect(Updater.decodePolicy('{ "autoupdate": true }')).toBe("auto")
    expect(Updater.decodePolicy("{}")).toBeUndefined()
  })

  it.live("notify (the default) tells about a newer release at startup and installs nothing", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      yield* test.publish("0.1.1")
      const updater = yield* test.make()
      yield* updater.startup(test.notify)
      expect(test.states).toEqual([{ type: "available", version: "0.1.1" }])
      expect(test.downloads()).toEqual([])
      expect(yield* test.current).toBe("0.1.0")
    }),
  )

  it.live("a startup check that cannot reach the releases only logs", () =>
    Effect.gen(function* () {
      const test = yield* install()
      yield* (yield* test.make()).startup(test.notify)
      expect(test.server.requests).toEqual(["/releases/latest/download/release.json"])
      expect(test.states).toEqual([])
    }),
  )

  it.live("false never checks on its own", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1", policy: '{ "autoupdate": false }' })
      yield* test.publish("0.1.1")
      yield* (yield* test.make()).startup(test.notify)
      expect(test.states).toEqual([])
      expect(test.server.requests).toEqual([])
    }),
  )

  it.live("true (auto) leaves it to the background service: a TUI's startup check sends no request", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1", policy: '{ "autoupdate": true }' })
      yield* test.publish("0.1.1")
      yield* (yield* test.make()).startup(test.notify)
      expect(test.states).toEqual([])
      expect(test.server.requests).toEqual([])
      expect(yield* test.current).toBe("0.1.0")
    }),
  )

  it.live("the policy is the last of config.json, opencode.json and opencode.jsonc that sets it", () =>
    Effect.gen(function* () {
      const test = yield* install({ policy: '{ "update": "auto" }' })
      const updater = yield* test.make()
      expect(yield* updater.policy()).toBe("auto")
      const config = paths(test.directory).config
      yield* Effect.promise(() => fs.writeFile(path.join(config, "opencode.jsonc"), '{ "update": "disable" }'))
      expect(yield* updater.policy()).toBe("disable")
      yield* Effect.promise(() => fs.rm(path.join(config, "opencode.jsonc")))
      yield* Effect.promise(() => fs.rm(path.join(config, "opencode.json")))
      expect(yield* updater.policy()).toBe("notify")
    }),
  )
})

describe("automatic update", () => {
  it.live("finds a newer release with one request, switches to it and says so in the upgrade log", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      yield* test.publish("0.1.1")
      const updater = yield* test.make()
      expect(yield* updater.newer()).toBe("0.1.1")
      expect(test.server.requests).toEqual(["/releases/latest/download/release.json"])
      expect(yield* updater.upgrade({ target: "0.1.1", automatic: true })).toEqual({
        type: "switched",
        from: "0.1.0",
        to: "0.1.1",
      })
      expect(yield* test.reported).toBe("0.1.1")
      const log = yield* Effect.promise(() => fs.readFile(test.switching.log, "utf8"))
      expect(log).toContain("0.1.0 -> 0.1.1: automatic update, started by the background service")
      expect(log).toContain("0.1.0 -> 0.1.1: switched automatically")
      // On 0.1.1 nothing is newer.
      expect(yield* (yield* test.make("0.1.1")).newer()).toBeUndefined()
    }),
  )

  it.live("says why it can't where it can't, and checks nothing", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      const updater = yield* test.make("0.1.0", { local: true })
      expect(yield* updater.unavailable()).toContain("source checkout")
      expect(yield* updater.newer()).toBeUndefined()
      expect(yield* (yield* test.make("0.1.0", { platform: undefined })).unavailable()).toContain("releases are built for")
      expect(test.server.requests).toEqual([])
      expect(yield* (yield* test.make()).unavailable()).toBeUndefined()
    }),
  )
})

describe("upgrade", () => {
  it.live("installs the latest release and switches to it whatever the policy", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1", policy: '{ "autoupdate": false }' })
      yield* test.publish("0.1.1")
      const updater = yield* test.make()
      expect(yield* updater.upgrade({ notify: test.notify })).toEqual({ type: "switched", from: "0.1.0", to: "0.1.1" })
      expect(test.states).toEqual([
        { type: "installing", version: "0.1.1" },
        { type: "switching", version: "0.1.1" },
        { type: "switched", version: "0.1.1" },
      ])
      expect(yield* test.reported).toBe("0.1.1")
      // The process that switched still runs 0.1.0's binary; it sees the new release as current.
      expect(yield* updater.upgrade()).toEqual({ type: "current", version: "0.1.1" })
    }),
  )

  it.live("switches while a tool runs and says what the switch waits for", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      yield* test.publish("0.1.1")
      yield* Effect.promise(() => fake(test.url, "/fake/work", [tool("ses_a")]))
      const upgrading = yield* (yield* test.make())
        .upgrade({ notify: test.notify })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* test.reports((state) => state.type === "switching" && state.waiting !== undefined)
      yield* Effect.promise(() => fake(test.url, "/fake/finish?sessionID=ses_a"))
      expect(yield* Fiber.join(upgrading).pipe(Effect.timeout("10 seconds"))).toEqual({
        type: "switched",
        from: "0.1.0",
        to: "0.1.1",
      })
      expect(test.states).toEqual([
        { type: "installing", version: "0.1.1" },
        { type: "switching", version: "0.1.1" },
        // The fake service's chat ses_a is titled, so the screens can name it.
        { type: "switching", version: "0.1.1", waiting: [{ ...tool("ses_a"), title: "Fix the tests" }] },
        { type: "switched", version: "0.1.1" },
      ])
      // The pause ended only once the tool had returned, and the service stopped after it.
      expect(yield* test.happened).toEqual(["0.1.0 paused", "0.1.0 stopped", "0.1.1 started paused", "0.1.1 resumed"])
    }),
  )

  it.live("tries again once the work finished when the pause gave up, and says what it waits for", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1", pause: Duration.seconds(1) })
      yield* test.publish("0.1.1")
      yield* Effect.promise(() => fake(test.url, "/fake/work", [tool("ses_a")]))
      const upgrading = yield* (yield* test.make())
        .upgrade({ notify: test.notify })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* test.reports("waiting")
      expect(test.states.at(-1)).toEqual({
        type: "waiting",
        version: "0.1.1",
        expired: { limit: 1_000, waiting: [{ ...tool("ses_a"), title: "Fix the tests" }] },
      })
      expect(yield* test.reported).toBe("0.1.0")
      expect(yield* test.happened).toEqual(["0.1.0 pause expired"])
      yield* Effect.promise(() => fake(test.url, "/fake/finish?sessionID=ses_a"))
      expect(yield* Fiber.join(upgrading).pipe(Effect.timeout("10 seconds"))).toMatchObject({ type: "switched" })
      expect(test.states.map((state) => state.type)).toEqual([
        "installing",
        "switching",
        "switching",
        "waiting",
        "switching",
        "switched",
      ])
      expect(yield* test.reported).toBe("0.1.1")
    }),
  )

  it.live("switches a service from before 0.1.0 once no chat runs on it", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.0", from: "0.0.1" })
      yield* test.publish("0.1.0")
      yield* Effect.promise(() => fake(test.url, "/fake/busy"))
      const upgrading = yield* (yield* test.make("0.0.1"))
        .upgrade({ notify: test.notify })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* test.reports("waiting")
      expect(test.states.at(-1)).toEqual({ type: "waiting", version: "0.1.0" })
      expect(yield* test.happened).toEqual([])
      yield* Effect.promise(() => fake(test.url, "/fake/idle"))
      expect(yield* Fiber.join(upgrading).pipe(Effect.timeout("10 seconds"))).toEqual({
        type: "switched",
        from: "0.0.1",
        to: "0.1.0",
      })
      expect(test.states.map((state) => state.type)).toEqual([
        "installing",
        "switching",
        "waiting",
        "switching",
        "switched",
      ])
      expect(yield* test.happened).toEqual(["0.0.1 stopped", "0.1.0 started paused", "0.1.0 resumed"])
    }),
  )

  it.live("says why it cannot upgrade an openforge that was not installed into the layout", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      const updater = yield* Updater.make({
        data: paths(test.directory).data,
        config: paths(test.directory).config,
        log: paths(test.directory).log,
        version: "0.1.0",
        local: false,
        disabled: false,
        executable: "/usr/local/bin/openforge",
        platform: "linux-x64",
        base: test.server.url,
        database: test.switching.database,
        service: Effect.succeed(test.switching.service),
        serviceDisabled: Effect.succeed(false),
      }).pipe(test.provide)
      const outcome = yield* updater.upgrade()
      expect(outcome).toMatchObject({ type: "unavailable" })
      if (outcome.type === "unavailable") expect(outcome.message).toContain("installed with install.sh")
      expect(test.server.requests).toEqual([])
    }),
  )

  it.live("neither checks nor upgrades while the background service is turned off", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1", policy: '{ "autoupdate": true }' })
      yield* test.publish("0.1.1")
      // With the service turned off (`openforge service set disabled true`) each TUI runs its own server on the
      // database instead.
      yield* Service.stop({ file: test.switching.service.file })
      const updater = yield* test.make("0.1.0", { serviceDisabled: Effect.succeed(true) })
      yield* updater.startup(test.notify)
      expect(test.states).toEqual([])
      const outcome = yield* updater.upgrade({ notify: test.notify })
      expect(outcome).toMatchObject({ type: "unavailable" })
      if (outcome.type === "unavailable") expect(outcome.message).toContain('"openforge service unset disabled"')
      // No managed service of the new release was started beside those servers.
      expect(yield* test.happened).toEqual(["0.1.0 stopped"])
      expect(yield* Service.discover({ file: test.switching.service.file })).toBeUndefined()
      expect(yield* test.current).toBe("0.1.0")
      expect(test.downloads()).toEqual([])
    }),
  )

  it.live("stays on the current release when the download is broken, and says why", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      yield* test.publish("0.1.1")
      test.releases["0.1.1"].SHA256SUMS = `${"0".repeat(64)}  openforge-linux-x64.tar.gz\n`
      const error = yield* (yield* test.make()).upgrade({ notify: test.notify }).pipe(Effect.flip)
      expect(error.message).toStartWith("upgrade to 0.1.1 failed: ")
      expect(error.message).toContain("disagree")
      expect(error.message).toEndWith(`; still on 0.1.0. Log: ${test.switching.log}`)
      expect(test.states.at(-1)).toEqual({ type: "failed", message: error.message })
      expect(yield* test.current).toBe("0.1.0")
      expect(yield* test.reported).toBe("0.1.0")
      const log = yield* Effect.promise(() => fs.readFile(test.switching.log, "utf8"))
      expect(log).toContain("0.1.0 -> 0.1.1: failed to install: ")
    }),
  )

  it.live("says so when the old service does not stop, and does not hold that against the new release", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      yield* test.publish("0.1.1")
      // A stop gives a service 12 s after SIGTERM and 5 s after SIGKILL; this one never goes.
      withEnsureTiming(test.switching.service, { stopPollInterval: 10, stopTimeout: 200, killTimeout: 200 })
      // 0.1.0's service again, now under a parent that never reaps it, as under a TUI that replaced itself: once
      // stopped it stays a zombie, which still counts as running.
      yield* Service.stop({ file: test.switching.service.file })
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(
            [
              "sh",
              "-c",
              '"$@" & exec sleep 60',
              "sh",
              ReleaseLayout.binary(test.switching.layout, "0.1.0"),
              "serve",
              "--service",
            ],
            { env: { ...process.env, ...test.switching.service.env }, stdout: "ignore", stderr: "inherit" },
          ),
        ),
        (keeper) =>
          Effect.promise(async () => {
            keeper.kill("SIGKILL")
            await keeper.exited
          }),
      )
      yield* test.reported.pipe(
        Effect.flatMap((version) => (version === "0.1.0" ? Effect.void : Effect.fail("not yet"))),
        Effect.retry(Schedule.spaced("20 millis")),
        Effect.timeout("5 seconds"),
      )
      const pid = (yield* Effect.promise(() => Bun.file(test.switching.service.file).json())).pid
      const error = yield* (yield* test.make()).upgrade({ notify: test.notify }).pipe(Effect.flip)
      const reason = `the background service did not stop: Server process ${pid} is still running`
      expect(error.message).toBe(`upgrade to 0.1.1 failed: ${reason}; still on 0.1.0. Log: ${test.switching.log}`)
      expect(test.states.at(-1)).toEqual({ type: "failed", message: error.message })
      expect(yield* test.current).toBe("0.1.0")
      expect(yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide)).toEqual({})
      const log = yield* Effect.promise(() => fs.readFile(test.switching.log, "utf8"))
      expect(log).toContain(`0.1.0 -> 0.1.1: stopping the background service\n`)
      expect(log).toContain(`0.1.0 -> 0.1.1: failed: ${reason}\n`)
    }),
  )

  it.live("rolls back a release that fails to start and does not retry it on its own until a newer one is out", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      yield* test.publish("0.1.1", "crash")
      const updater = yield* test.make()
      expect(yield* updater.newer()).toBe("0.1.1")
      const error = yield* updater.upgrade({ target: "0.1.1", automatic: true }).pipe(Effect.flip)
      expect(error.message).toStartWith("upgrade to 0.1.1 failed: the service of openforge 0.1.1 exited (code 3)")
      expect(error.message).toEndWith(`; still on 0.1.0. Log: ${test.switching.log}`)
      expect(yield* test.current).toBe("0.1.0")
      expect(yield* test.reported).toBe("0.1.0")
      // Kept as an automatic failure, with the reason the TUIs show.
      const bad = (yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide))["0.1.1"]
      expect(bad?.automatic).toBe(true)
      expect(bad?.reason).toStartWith("the service of openforge 0.1.1 exited (code 3)")

      // Neither the automatic check nor /update tries it again.
      expect(yield* updater.newer()).toBeUndefined()
      const again = yield* updater.upgrade().pipe(Effect.flip)
      expect(again.message).toContain("failed to start before and was rolled back")
      expect(again.message).toContain('run "openforge upgrade 0.1.1" to try it again')
      expect(test.downloads()).toHaveLength(1)

      // By hand it is tried again (and rolls back again).
      expect((yield* updater.upgrade({ target: "0.1.1" }).pipe(Effect.flip)).message).toStartWith(
        "upgrade to 0.1.1 failed: ",
      )

      // A newer release is tried on its own.
      yield* test.publish("0.1.2")
      test.server.latest("0.1.2")
      expect(yield* updater.newer()).toBe("0.1.2")
      yield* updater.upgrade({ target: "0.1.2", automatic: true })
      expect(yield* test.current).toBe("0.1.2")
      expect(Object.keys(yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide))).toEqual(["0.1.1"])
    }),
  )

  it.live("an automatic update that fails before the switch is not tried again on its own either", () =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      yield* test.publish("0.1.1")
      test.releases["0.1.1"].SHA256SUMS = `${"0".repeat(64)}  openforge-linux-x64.tar.gz\n`
      const updater = yield* test.make()
      yield* updater.upgrade({ target: "0.1.1", automatic: true }).pipe(Effect.flip)
      expect(yield* test.current).toBe("0.1.0")
      expect((yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide))["0.1.1"]?.automatic).toBe(true)
      expect(yield* updater.newer()).toBeUndefined()
    }),
  )
})

describe("another screen", () => {
  // Switches to 0.1.1, whose check waits for the test, while another screen's reconnect reaches its service: that
  // takes the service as soon as it registers, still paused. Then the check passes or fails.
  const reached = (check: string) =>
    Effect.gen(function* () {
      const test = yield* install({ latest: "0.1.1" })
      yield* test.publish("0.1.1", "held")
      const upgrading = yield* (yield* test.make())
        .upgrade({ notify: test.notify })
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      const endpoint = yield* Service.discovered({ file: test.switching.service.file, version: "0.1.1" })
      // The screen runs 0.1.0 too, in a process of its own.
      const restart = yield* (yield* test.make())
        .switchedTo(endpoint)
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => fake(endpoint.url, check))
      return {
        ...test,
        upgraded: yield* Fiber.join(upgrading).pipe(Effect.timeout("10 seconds")),
        restart: Fiber.join(restart).pipe(Effect.timeout("10 seconds")),
      }
    })

  it.live("restarts on the new release once the switch is done", () =>
    Effect.gen(function* () {
      const test = yield* reached("/fake/check")
      expect(test.upgraded).toEqual(Exit.succeed({ type: "switched", from: "0.1.0", to: "0.1.1" }))
      expect(yield* test.restart).toBe("0.1.1")
    }),
  )

  it.live("does not restart on a new release whose switch then rolls back", () =>
    Effect.gen(function* () {
      const test = yield* reached("/fake/check?runner=lost")
      expect(Exit.isFailure(test.upgraded)).toBe(true)
      expect(yield* test.current).toBe("0.1.0")
      expect(yield* test.reported).toBe("0.1.0")
      expect(yield* test.restart).toBeUndefined()
    }),
  )
})

describe("going back by hand", () => {
  // 0.1.0 -> 0.1.1, where 0.1.1 added migration m-0.1.1 to the database.
  const upgraded = Effect.gen(function* () {
    const test = yield* install({ latest: "0.1.1" })
    yield* test.publish("0.1.1")
    yield* (yield* test.make()).upgrade()
    expect(migrations(test.switching.database)).toEqual(["m-0.1.0", "m-0.1.1"])
    return { ...test, updater: yield* test.make("0.1.1") }
  })

  it.live("switches to a kept release that knows every migration of the database", () =>
    Effect.gen(function* () {
      const test = yield* upgraded
      // Pretend 0.1.0 knew 0.1.1's database change when it was left.
      writeMigrations(ReleaseSwitch.copyOf(test.switching, "0.1.0"), ["m-0.1.1"])
      expect(yield* test.updater.upgrade({ target: "0.1.0" })).toEqual({ type: "switched", from: "0.1.1", to: "0.1.0" })
      expect(yield* test.reported).toBe("0.1.0")
      expect(migrations(test.switching.database)).toEqual(["m-0.1.0", "m-0.1.1"])
      // No download: the release was kept.
      expect(test.downloads()).toHaveLength(1)
    }),
  )

  it.live("refuses a kept release that cannot read the database and offers the copy made when it was left", () =>
    Effect.gen(function* () {
      const test = yield* upgraded
      const error = yield* test.updater.upgrade({ target: "0.1.0" }).pipe(Effect.flip)
      expect(error.message).toContain("openforge 0.1.0 can't read the current database")
      expect(error.message).toContain("(m-0.1.1)")
      expect(error.message).toContain("lacks everything stored since then")
      expect(error.message).toContain("openforge upgrade 0.1.0 --restore-database")
      expect(yield* test.current).toBe("0.1.1")
      expect(yield* test.reported).toBe("0.1.1")

      expect(yield* test.updater.upgrade({ target: "0.1.0", restoreDatabase: true })).toEqual({
        type: "switched",
        from: "0.1.1",
        to: "0.1.0",
      })
      expect(yield* test.reported).toBe("0.1.0")
      expect(migrations(test.switching.database)).toEqual(["m-0.1.0"])
      // The newer database stays beside 0.1.1, so going forward again can take it back.
      expect(migrations(ReleaseSwitch.copyOf(test.switching, "0.1.1"))).toEqual(["m-0.1.0", "m-0.1.1"])
    }),
  )

  it.live("refuses an older release that was never in use, since nothing shows what it can read", () =>
    Effect.gen(function* () {
      const test = yield* upgraded
      yield* Effect.promise(() => keep(test.switching.layout, "0.0.9"))
      const error = yield* test.updater.upgrade({ target: "0.0.9" }).pipe(Effect.flip)
      expect(error.message).toContain("openforge 0.0.9 was never left on this machine")
      expect(yield* test.reported).toBe("0.1.1")
    }),
  )
})
