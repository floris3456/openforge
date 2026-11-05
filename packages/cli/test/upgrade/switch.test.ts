import { NodeServices } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { describeWork, type SwitchWork } from "@opencode/client/promise"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Deferred, Duration, Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { ancestors } from "../../../client/test/fixture/service-fixture"
import { testEffect } from "../../../core/test/lib/effect"
import { ReleaseDatabase } from "../../src/upgrade/database"
import { ReleaseLayout } from "../../src/upgrade/layout"
import { ReleaseSwitch } from "../../src/upgrade/switch"
import { SwitchLock } from "../../src/upgrade/switch-lock"
import {
  fake,
  happened,
  history,
  keep,
  layer,
  migrations,
  root,
  target,
  writeMigrations,
  type Serve,
} from "./fixture/fixture"

const it = testEffect(NodeServices.layer)

// An install with `from` in use and its service running, plus `to` kept beside it. What happened to the fake
// services before the test starts is left out of `happened`. With `terminals` the services hold persistent terminals
// (see fake-openforge.ts).
const installed = (
  from: string,
  to?: { readonly version: string; readonly serve?: Serve },
  options: { readonly pause?: Duration.Duration; readonly terminals?: boolean } = {},
) =>
  Effect.gen(function* () {
    const directory = yield* root
    const base = yield* target(directory)
    const switching = {
      ...base,
      pause: options.pause,
      service: options.terminals
        ? { ...base.service, env: { ...base.service.env, FAKE_TERMINALS: "1" } }
        : base.service,
    }
    yield* Effect.promise(() => keep(switching.layout, from))
    if (to) yield* Effect.promise(() => keep(switching.layout, to.version, { serve: to.serve }))
    yield* ReleaseLayout.point(switching.layout, from).pipe(Effect.provide(layer(directory)))
    const started = yield* ReleaseSwitch.start(switching, from).pipe(Effect.provide(layer(directory)))
    const url = started.endpoint.url
    if (started.paused) yield* Effect.promise(() => fake(url, "/api/experimental/service/resume"))
    yield* Effect.promise(() => fs.rm(history(directory), { force: true }))
    return {
      directory,
      switching,
      url,
      provide: Effect.provide(layer(directory)),
      happened: Effect.promise(() => happened(directory)),
    }
  })

const reported = (switching: ReleaseSwitch.Target) =>
  Effect.gen(function* () {
    const endpoint = yield* Service.discover({ file: switching.service.file })
    if (!endpoint) return undefined
    const info = yield* Effect.promise(() =>
      fetch(new URL("/api/info", endpoint.url)).then((response) => response.json()),
    )
    return info as { version: string; switching?: string }
  })

// What the running service says about its pause.
const paused = (switching: ReleaseSwitch.Target) =>
  Effect.gen(function* () {
    const endpoint = yield* Service.discover({ file: switching.service.file })
    if (!endpoint) return undefined
    const body = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/service/status", endpoint.url)).then((response) => response.json()),
    )
    return (body as { data: { state: string; startedPaused: boolean } }).data
  })

const tool = (sessionID: string, name = "webfetch") => ({ sessionID, kind: "tool" as const, name })

describe("pausable", () => {
  test("releases from 0.1.0 on can pause, earlier ones cannot", () => {
    expect(ReleaseSwitch.pausable("0.1.0")).toBe(true)
    expect(ReleaseSwitch.pausable("0.1.0-beta.1")).toBe(true)
    expect(ReleaseSwitch.pausable("0.1.2")).toBe(true)
    expect(ReleaseSwitch.pausable("0.2.0")).toBe(true)
    expect(ReleaseSwitch.pausable("1.0.0")).toBe(true)
    expect(ReleaseSwitch.pausable("0.0.9")).toBe(false)
    expect(ReleaseSwitch.pausable("0.0.1")).toBe(false)
    expect(ReleaseSwitch.pausable("not a version")).toBe(false)
  })
})

describe("switch steps", () => {
  it.live("copies the database consistently with VACUUM INTO and restores the copy", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const database = path.join(directory, "opencode.db")
      const copy = path.join(directory, "releases", "0.1.0", "opencode.db")
      const db = new Database(database)
      db.run("PRAGMA journal_mode = WAL")
      db.run("CREATE TABLE note (text TEXT)")
      db.run("INSERT INTO note VALUES ('before')")
      // The open connection keeps the row in the WAL; the copy must still contain it.
      expect(yield* ReleaseDatabase.copy(database, copy).pipe(Effect.provide(layer(directory)))).toBe(true)
      db.run("INSERT INTO note VALUES ('after')")
      db.close()
      yield* ReleaseDatabase.restore(copy, database).pipe(Effect.provide(layer(directory)))
      using restored = new Database(database, { readonly: true })
      expect(restored.query("SELECT text FROM note").all()).toEqual([{ text: "before" }])
      expect(yield* Effect.promise(() => fs.exists(`${database}-wal`))).toBe(false)
      expect(yield* Effect.promise(() => fs.exists(`${copy}-wal`))).toBe(false)
      expect(
        yield* ReleaseDatabase.copy(path.join(directory, "missing.db"), copy).pipe(Effect.provide(layer(directory))),
      ).toBe(false)
    }),
  )

  it.live("reads the migration journal of a database", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const database = path.join(directory, "opencode.db")
      yield* Effect.promise(async () => writeMigrations(database, ["20260101_a", "20260202_b"]))
      const read = (file: string) => ReleaseDatabase.migrations(file).pipe(Effect.provide(layer(directory)))
      expect((yield* read(database))?.toSorted()).toEqual(["20260101_a", "20260202_b"])
      expect(yield* read(path.join(directory, "missing.db"))).toBeUndefined()
      yield* Effect.sync(() => new Database(path.join(directory, "empty.db")).close())
      expect(yield* read(path.join(directory, "empty.db"))).toEqual([])
    }),
  )

  it.live(
    "starts the service from current paused and requires it to report the version",
    () =>
      Effect.gen(function* () {
        const test = yield* installed("0.1.0", { version: "0.1.1", serve: "wrong-version" })
        const info = yield* reported(test.switching)
        expect(info?.version).toBe("0.1.0")
        // The service a switch starts skips the switch lock it would otherwise wait for.
        expect(info?.switching).toBe("1")
        yield* Service.stop(test.switching.service)
        expect(yield* Service.discover({ file: test.switching.service.file })).toBeUndefined()
        yield* ReleaseLayout.point(test.switching.layout, "0.1.1").pipe(test.provide)
        const error = yield* ReleaseSwitch.start(test.switching, "0.1.1").pipe(test.provide, Effect.flip)
        expect(error.message).toContain("did not answer with that version within 4s")
        expect(yield* test.happened).toEqual(["0.1.0 stopped", "0.1.1 started paused", "0.1.1 stopped"])
      }),
    // The check waits its full 4 s for the version.
    15_000,
  )

  it.live("starts a release from before 0.1.0 without pausing it, as it has no such flag", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const switching = yield* target(directory)
      yield* Effect.promise(() => keep(switching.layout, "0.0.1"))
      yield* ReleaseLayout.point(switching.layout, "0.0.1").pipe(Effect.provide(layer(directory)))
      const started = yield* ReleaseSwitch.start(switching, "0.0.1").pipe(Effect.provide(layer(directory)))
      expect(started.paused).toBe(false)
      expect(yield* Effect.promise(() => happened(directory))).toEqual(["0.0.1 started"])
    }),
  )

  it.live("fails the check of a service that cannot read its database and stops it", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1", serve: "unreadable" })
      yield* Service.stop(test.switching.service)
      yield* ReleaseLayout.point(test.switching.layout, "0.1.1").pipe(test.provide)
      const error = yield* ReleaseSwitch.start(test.switching, "0.1.1").pipe(test.provide, Effect.flip)
      expect(error.message).toContain("failed its check: it could not read its database")
      expect(yield* test.happened).toEqual(["0.1.0 stopped", "0.1.1 started paused", "0.1.1 stopped"])
    }),
  )

  // The TUI that switches replaces itself with the new release next and would never reap a child.
  it.live("starts the service outside the switching process", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0")
      const info = yield* Effect.promise(() => Bun.file(test.switching.service.file).json())
      expect(ancestors(info.pid)).not.toContain(process.pid)
    }),
  )
})

describe("switch", () => {
  it.live("pauses the old service, stops it, starts the new one paused, checks it and resumes it", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1" })
      const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(result).toEqual({ type: "switched", from: "0.1.0", to: "0.1.1" })
      expect(yield* test.happened).toEqual(["0.1.0 paused", "0.1.0 stopped", "0.1.1 started paused", "0.1.1 resumed"])
      expect(yield* ReleaseLayout.current(test.switching.layout).pipe(test.provide)).toBe("0.1.1")
      expect((yield* reported(test.switching))?.version).toBe("0.1.1")
      expect(yield* paused(test.switching)).toMatchObject({ state: "running", startedPaused: false })
      expect(migrations(ReleaseSwitch.copyOf(test.switching, "0.1.0"))).toEqual(["m-0.1.0"])
      expect(migrations(test.switching.database)).toEqual(["m-0.1.0", "m-0.1.1"])
      expect(yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide)).toEqual({})
      const log = yield* Effect.promise(() => fs.readFile(test.switching.log, "utf8"))
      expect(log).toContain("0.1.0 -> 0.1.1: pausing the background service (at most 2m)")
      expect(log).toContain("0.1.0 -> 0.1.1: paused; 1 chat(s) rest")
    }),
  )

  it.live("switches while a tool runs, once the tool has returned, reporting what it waits for", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1" })
      yield* Effect.promise(() => fake(test.url, "/fake/work", [tool("ses_a"), tool("ses_untitled", "bash")]))
      const reports = yield* Deferred.make<ReadonlyArray<SwitchWork>>()
      const running = yield* ReleaseSwitch.run(test.switching, {
        from: "0.1.0",
        to: "0.1.1",
        onWaiting: (waiting) => Deferred.doneUnsafe(reports, Effect.succeed(waiting)),
      }).pipe(test.provide, Effect.forkChild({ startImmediately: true }))
      const reported = yield* Deferred.await(reports).pipe(Effect.timeout("5 seconds"))
      // Each chat is read for its title.
      expect(reported).toEqual([{ ...tool("ses_a"), title: "Fix the tests" }, tool("ses_untitled", "bash")])
      expect(describeWork(reported)).toBe('webfetch in "Fix the tests", bash in an untitled chat')
      // Nothing has stopped while the tool runs.
      expect(yield* test.happened).toEqual([])
      yield* Effect.promise(() => fake(test.url, "/fake/finish?sessionID=ses_a"))
      yield* Effect.promise(() => fake(test.url, "/fake/finish?sessionID=ses_untitled"))
      expect(yield* Fiber.join(running).pipe(Effect.timeout("10 seconds"))).toEqual({
        type: "switched",
        from: "0.1.0",
        to: "0.1.1",
      })
      expect(yield* test.happened).toEqual(["0.1.0 paused", "0.1.0 stopped", "0.1.1 started paused", "0.1.1 resumed"])
    }),
  )

  it.live("leaves the service running when the pause gives up, and switches once the work it reported finished", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1" }, { pause: Duration.seconds(1) })
      yield* Effect.promise(() => fake(test.url, "/fake/work", [tool("ses_a")]))
      const busy = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(busy).toEqual({
        type: "busy",
        expired: { limit: 1_000, waiting: [{ ...tool("ses_a"), title: "Fix the tests" }] },
      })
      expect(yield* test.happened).toEqual(["0.1.0 pause expired"])
      expect((yield* reported(test.switching))?.version).toBe("0.1.0")
      expect(yield* paused(test.switching)).toMatchObject({ state: "running" })
      const log = yield* Effect.promise(() => fs.readFile(test.switching.log, "utf8"))
      expect(log).toContain(
        'the pause gave up after 1s and the service carries on; switching once this has finished: webfetch in "Fix the tests"',
      )

      const before = Number(yield* Effect.promise(() => fake(test.url, "/fake/reads?of=status")))
      const finished = yield* ReleaseSwitch.finished(test.switching, [tool("ses_a")]).pipe(
        test.provide,
        Effect.forkChild({ startImmediately: true }),
      )
      // It reads the status once it listens, and again after each event while it waits.
      const reads = (count: number) =>
        Effect.promise(() => fake(test.url, `/fake/reads?of=status&count=${before + count}`)).pipe(
          Effect.timeout("5 seconds"),
        )
      yield* reads(1)
      // The chat's step ends while its tool keeps running: the switch keeps waiting, so it reads again after the next.
      yield* Effect.promise(() => fake(test.url, "/fake/step?sessionID=ses_a"))
      yield* reads(2)
      yield* Effect.promise(() => fake(test.url, "/fake/step?sessionID=ses_a"))
      yield* reads(3)
      yield* Effect.promise(() => fake(test.url, "/fake/finish?sessionID=ses_a"))
      yield* Fiber.join(finished).pipe(Effect.timeout("5 seconds"))

      const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(result).toEqual({ type: "switched", from: "0.1.0", to: "0.1.1" })
      expect((yield* test.happened).slice(1)).toEqual([
        "0.1.0 paused",
        "0.1.0 stopped",
        "0.1.1 started paused",
        "0.1.1 resumed",
      ])
    }),
  )

  it.live("opens the old service again when the switch is dropped while it pauses", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1" })
      yield* Effect.promise(() => fake(test.url, "/fake/work", [tool("ses_a")]))
      const reports = yield* Deferred.make<void>()
      const running = yield* ReleaseSwitch.run(test.switching, {
        from: "0.1.0",
        to: "0.1.1",
        onWaiting: () => Deferred.doneUnsafe(reports, Effect.void),
      }).pipe(test.provide, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(reports).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(running)
      expect(yield* test.happened).toEqual(["0.1.0 resumed"])
      expect(yield* paused(test.switching)).toMatchObject({ state: "running" })
      expect(yield* ReleaseLayout.current(test.switching.layout).pipe(test.provide)).toBe("0.1.0")
    }),
  )

  it.live("switches a service from before 0.1.0 once no chat runs on it, as those releases did", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.0.1", { version: "0.1.0" })
      yield* Effect.promise(() => fake(test.url, "/fake/busy"))
      const busy = yield* ReleaseSwitch.run(test.switching, { from: "0.0.1", to: "0.1.0" }).pipe(test.provide)
      expect(busy).toEqual({ type: "busy" })
      expect(yield* test.happened).toEqual([])
      const log = yield* Effect.promise(() => fs.readFile(test.switching.log, "utf8"))
      expect(log).toContain("0.0.1 -> 0.1.0: the running service cannot pause; switching once no chat is running")

      const before = Number(yield* Effect.promise(() => fake(test.url, "/fake/reads?of=active")))
      const idle = yield* ReleaseSwitch.idle(test.switching).pipe(
        test.provide,
        Effect.forkChild({ startImmediately: true }),
      )
      // It reads the running chats once it listens, and again after each execution that ends while it waits.
      const reads = (count: number) =>
        Effect.promise(() => fake(test.url, `/fake/reads?of=active&count=${before + count}`)).pipe(
          Effect.timeout("5 seconds"),
        )
      yield* reads(1)
      // Another chat's execution ends while one still runs: it keeps waiting, so it reads again after the next.
      yield* Effect.promise(() => fake(test.url, "/fake/executed"))
      yield* reads(2)
      yield* Effect.promise(() => fake(test.url, "/fake/executed"))
      yield* reads(3)
      yield* Effect.promise(() => fake(test.url, "/fake/idle"))
      yield* Fiber.join(idle).pipe(Effect.timeout("5 seconds"))

      const result = yield* ReleaseSwitch.run(test.switching, { from: "0.0.1", to: "0.1.0" }).pipe(test.provide)
      expect(result).toEqual({ type: "switched", from: "0.0.1", to: "0.1.0" })
      expect(yield* test.happened).toEqual(["0.0.1 stopped", "0.1.0 started paused", "0.1.0 resumed"])
    }),
  )

  it.live("rolls back the link, the database and the service when the new service crashes", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1", serve: "crash" })
      const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(result).toMatchObject({ type: "rolled-back", from: "0.1.0", to: "0.1.1", restored: true })
      if (result.type !== "rolled-back") return
      expect(result.reason).toContain("exited (code 3)")
      expect(result.reason).toContain("fake openforge 0.1.1 crashed on start")
      // The old release starts paused and resumes, so the chats that rested continue there.
      expect(yield* test.happened).toEqual(["0.1.0 paused", "0.1.0 stopped", "0.1.0 started paused", "0.1.0 resumed"])
      expect(yield* ReleaseLayout.current(test.switching.layout).pipe(test.provide)).toBe("0.1.0")
      expect((yield* reported(test.switching))?.version).toBe("0.1.0")
      expect(yield* paused(test.switching)).toMatchObject({ state: "running", startedPaused: false })
      // The crashed release had already migrated the database; the restored copy has no trace of it.
      expect(migrations(test.switching.database)).toEqual(["m-0.1.0"])
      const bad = yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide)
      expect(Object.keys(bad)).toEqual(["0.1.1"])
      expect(bad["0.1.1"].log).toBe(test.switching.log)
      const log = yield* Effect.promise(() => fs.readFile(test.switching.log, "utf8"))
      expect(log).toContain("0.1.0 -> 0.1.1: failed: ")
      expect(log).toContain("rolled back; the service reports 0.1.0")
    }),
  )

  it.live("hands the persistent terminals on to the new release", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1" }, { terminals: true })
      const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(result).toEqual({ type: "switched", from: "0.1.0", to: "0.1.1" })
      expect(yield* test.happened).toEqual([
        "0.1.0 paused",
        "0.1.0 handoff ticket-0.1.0",
        "0.1.0 stopped",
        "0.1.1 adopts ticket-0.1.0",
        "0.1.1 started paused",
        "0.1.1 resumed",
      ])
    }),
  )

  it.live(
    "gives the persistent terminals back to the old release when the new service crashed before it registered",
    () =>
      Effect.gen(function* () {
        const test = yield* installed("0.1.0", { version: "0.1.1", serve: "crash" }, { terminals: true })
        const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
        expect(result).toMatchObject({ type: "rolled-back", restored: true })
        // 0.1.1 crashed before it took the terminals over, so the ticket 0.1.0 handed them on with is still good.
        expect(yield* test.happened).toEqual([
          "0.1.0 paused",
          "0.1.0 handoff ticket-0.1.0",
          "0.1.0 stopped",
          "0.1.1 adopts ticket-0.1.0",
          "0.1.0 adopts ticket-0.1.0",
          "0.1.0 started paused",
          "0.1.0 resumed",
        ])
      }),
  )

  for (const serve of ["unreadable", "runner-lost", "unresumable"] as const)
    it.live(
      `gives the persistent terminals back to the old release when the new service took them and then failed (${serve})`,
      () =>
        Effect.gen(function* () {
          const test = yield* installed("0.1.0", { version: "0.1.1", serve }, { terminals: true })
          const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
          expect(result).toMatchObject({ type: "rolled-back", restored: true })
          // 0.1.1 took the terminals over as it started; asked before it stops, it hands them back with its own ticket.
          expect(yield* test.happened).toEqual([
            "0.1.0 paused",
            "0.1.0 handoff ticket-0.1.0",
            "0.1.0 stopped",
            "0.1.1 adopts ticket-0.1.0",
            "0.1.1 started paused",
            "0.1.1 handoff ticket-0.1.1",
            "0.1.1 stopped",
            "0.1.0 adopts ticket-0.1.1",
            "0.1.0 started paused",
            "0.1.0 resumed",
          ])
        }),
    )

  it.live("rolls back when the new service can't reach a tool runner that holds commands", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1", serve: "runner-lost" })
      const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(result).toMatchObject({ type: "rolled-back", restored: true })
      if (result.type !== "rolled-back") return
      expect(result.reason).toContain(
        "failed its check: it can't reach the tool runner of openforge 0.1.0 (it speaks no protocol this release knows)",
      )
      expect(yield* test.happened).toEqual([
        "0.1.0 paused",
        "0.1.0 stopped",
        "0.1.1 started paused",
        "0.1.1 stopped",
        "0.1.0 started paused",
        "0.1.0 resumed",
      ])
      expect((yield* reported(test.switching))?.version).toBe("0.1.0")
      expect(Object.keys(yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide))).toEqual(["0.1.1"])
    }),
  )

  it.live("rolls back when the new service cannot read its database", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1", serve: "unreadable" })
      const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(result).toMatchObject({ type: "rolled-back", restored: true })
      if (result.type !== "rolled-back") return
      expect(result.reason).toContain("failed its check: it could not read its database")
      expect(yield* test.happened).toEqual([
        "0.1.0 paused",
        "0.1.0 stopped",
        "0.1.1 started paused",
        "0.1.1 stopped",
        "0.1.0 started paused",
        "0.1.0 resumed",
      ])
      expect((yield* reported(test.switching))?.version).toBe("0.1.0")
      expect(migrations(test.switching.database)).toEqual(["m-0.1.0"])
      expect(Object.keys(yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide))).toEqual(["0.1.1"])
    }),
  )

  it.live(
    "rolls back when the new service answers with another version",
    () =>
      Effect.gen(function* () {
        const test = yield* installed("0.1.0", { version: "0.1.1", serve: "wrong-version" })
        const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
        expect(result).toMatchObject({ type: "rolled-back", restored: true })
        expect(yield* ReleaseLayout.current(test.switching.layout).pipe(test.provide)).toBe("0.1.0")
        expect((yield* reported(test.switching))?.version).toBe("0.1.0")
        expect(yield* paused(test.switching)).toMatchObject({ state: "running" })
        expect(migrations(test.switching.database)).toEqual(["m-0.1.0"])
      }),
    // The check waits its full 4 s for the version.
    15_000,
  )

  it.live("restarts the old release, keeps its database and marks nothing bad when the copy fails", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1" })
      const folder = ReleaseLayout.folder(test.switching.layout, "0.1.0")
      // Only the original database holds this row; a recreated one would not.
      writeMigrations(test.switching.database, ["user-data"])
      // The copy goes beside 0.1.0's binary; a read-only folder makes VACUUM INTO fail.
      yield* Effect.acquireRelease(
        Effect.promise(() => fs.chmod(folder, 0o555)),
        () => Effect.promise(() => fs.chmod(folder, 0o755)),
      )
      const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(result).toMatchObject({ type: "rolled-back", restored: true })
      if (result.type !== "rolled-back") return
      expect(result.reason).toStartWith("could not use the database")
      expect(yield* test.happened).toEqual(["0.1.0 paused", "0.1.0 stopped", "0.1.0 started paused", "0.1.0 resumed"])
      expect(yield* ReleaseLayout.current(test.switching.layout).pipe(test.provide)).toBe("0.1.0")
      expect((yield* reported(test.switching))?.version).toBe("0.1.0")
      expect(migrations(test.switching.database)).toEqual(["m-0.1.0", "user-data"])
      expect(yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide)).toEqual({})
    }),
  )

  it.live("removes the database a failed release created when there was none before", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1", serve: "crash" })
      yield* Effect.promise(() => fs.rm(test.switching.database))
      const result = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(result).toMatchObject({ type: "rolled-back", restored: true })
      // Only 0.1.0, started again, wrote to the database that is there now.
      expect(migrations(test.switching.database)).toEqual(["m-0.1.0"])
    }),
  )

  it.live("leaves everything alone when another process already switched", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.1.0", { version: "0.1.1" })
      yield* ReleaseLayout.point(test.switching.layout, "0.1.1").pipe(test.provide)
      const unchanged = yield* ReleaseSwitch.run(test.switching, { from: "0.1.0", to: "0.1.1" }).pipe(test.provide)
      expect(unchanged).toEqual({ type: "unchanged", version: "0.1.1" })
      expect(yield* test.happened).toEqual([])
      expect((yield* reported(test.switching))?.version).toBe("0.1.0")
      expect(yield* Effect.promise(() => fs.exists(ReleaseSwitch.copyOf(test.switching, "0.1.0")))).toBe(false)
    }),
  )
})

describe("waiting", () => {
  it.live("a starting service waits while another process holds the switch lock", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const layout = ReleaseLayout.at(path.join(directory, "data"))
      const flock = yield* EffectFlock.Service.pipe(Effect.provide(layer(directory)))
      const acquired = yield* Deferred.make<void>()
      const held = yield* Effect.forkChild(
        Effect.scoped(
          flock
            .acquire(SwitchLock.key, layout.locks)
            .pipe(Effect.andThen(Deferred.succeed(acquired, undefined)), Effect.andThen(Effect.never)),
        ),
        { startImmediately: true },
      )
      yield* Deferred.await(acquired)
      // The starting service asks for the switch lock, and gets it once the holder lets go.
      const asked = yield* Deferred.make<{ readonly key: string; readonly dir?: string }>()
      const waiting = yield* SwitchLock.wait(layout.locks).pipe(
        Effect.provideService(EffectFlock.Service, {
          ...flock,
          acquire: (key, dir, options) =>
            Deferred.succeed(asked, { key, dir }).pipe(Effect.andThen(flock.acquire(key, dir, options))),
        }),
        Effect.provide(layer(directory)),
        Effect.forkChild({ startImmediately: true }),
      )
      expect(yield* Deferred.await(asked)).toEqual({ key: SwitchLock.key, dir: layout.locks })
      yield* Fiber.interrupt(held)
      yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"))
    }),
  )

  it.live(
    "tells whether a switch holds its lock, and shows none where the lock folder is missing or can't be read",
    () =>
      Effect.gen(function* () {
        const directory = yield* root
        const provide = Effect.provide(layer(directory))
        const locks = ReleaseLayout.at(path.join(directory, "data")).locks
        expect(yield* SwitchLock.held(locks).pipe(provide)).toBe(false)
        // Asking wrote nothing.
        expect(yield* Effect.promise(() => fs.exists(locks))).toBe(false)
        const flock = yield* EffectFlock.Service.pipe(provide)
        yield* flock.acquire(SwitchLock.key, locks, { timeoutMs: 1_000 })
        expect(yield* SwitchLock.held(locks).pipe(provide)).toBe(true)
        const sealed = path.join(directory, "sealed")
        yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdir(sealed, { mode: 0o000 })),
          () => Effect.promise(() => fs.chmod(sealed, 0o755)),
        )
        expect(yield* SwitchLock.held(sealed).pipe(provide)).toBe(false)
      }),
  )

  it.live("the service a switch starts does not wait for the switch's lock", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const flock = yield* EffectFlock.Service.pipe(Effect.provide(layer(directory)))
      yield* Effect.acquireRelease(
        Effect.sync(() => (process.env[SwitchLock.variable] = "1")),
        () => Effect.sync(() => delete process.env[SwitchLock.variable]),
      )
      const locks = ReleaseLayout.at(path.join(directory, "data")).locks
      yield* flock.acquire(SwitchLock.key, locks)
      yield* SwitchLock.wait(locks).pipe(Effect.provide(layer(directory)), Effect.timeout("2 seconds"))
      expect(process.env[SwitchLock.variable]).toBeUndefined()
    }),
  )
})
