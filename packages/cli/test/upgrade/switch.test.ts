import { NodeServices } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Database } from "bun:sqlite"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { ancestors } from "../../../client/test/fixture/service-fixture"
import { testEffect } from "../../../core/test/lib/effect"
import { ReleaseDatabase } from "../../src/upgrade/database"
import { ReleaseLayout } from "../../src/upgrade/layout"
import { ReleaseSwitch } from "../../src/upgrade/switch"
import { SwitchLock } from "../../src/upgrade/switch-lock"
import { keep, layer, migrations, root, target, writeMigrations, type Serve } from "./fixture/fixture"

const it = testEffect(NodeServices.layer)

// An install with `from` in use and its service running, plus `to` kept beside it.
const installed = (from: string, to?: { readonly version: string; readonly serve?: Serve }) =>
  Effect.gen(function* () {
    const directory = yield* root
    const switching = yield* target(directory)
    yield* Effect.promise(() => keep(switching.layout, from))
    if (to) yield* Effect.promise(() => keep(switching.layout, to.version, { serve: to.serve }))
    yield* ReleaseLayout.point(switching.layout, from).pipe(Effect.provide(layer(directory)))
    yield* ReleaseSwitch.start(switching, from).pipe(Effect.provide(layer(directory)))
    return { directory, switching, provide: Effect.provide(layer(directory)) }
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

describe("switch steps", () => {
  it.live("copies the database consistently with VACUUM INTO and restores the copy", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const database = path.join(directory, "opencode.db")
      const copy = path.join(directory, "releases", "0.0.1", "opencode.db")
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

  it.live("starts the service from current and requires it to report the version", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.0.1", { version: "0.0.2", serve: "wrong-version" })
      const info = yield* reported(test.switching)
      expect(info?.version).toBe("0.0.1")
      // The service a switch starts skips the switch lock it would otherwise wait for.
      expect(info?.switching).toBe("1")
      yield* ReleaseSwitch.stop(test.switching).pipe(test.provide)
      expect(yield* Service.discover({ file: test.switching.service.file })).toBeUndefined()
      yield* ReleaseLayout.point(test.switching.layout, "0.0.2").pipe(test.provide)
      const error = yield* ReleaseSwitch.start(test.switching, "0.0.2").pipe(test.provide, Effect.flip)
      expect(error.message).toContain("did not answer with that version within 4s")
    }),
  )

  // The TUI that switches replaces itself with the new release next and would never reap a child.
  it.live("starts the service outside the switching process", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.0.1")
      const info = yield* Effect.promise(() => Bun.file(test.switching.service.file).json())
      expect(ancestors(info.pid)).not.toContain(process.pid)
    }),
  )
})

describe("switch", () => {
  it.live("switches to the new release and keeps a copy of the database next to the old one", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.0.1", { version: "0.0.2" })
      const result = yield* ReleaseSwitch.run(test.switching, {
        from: "0.0.1",
        to: "0.0.2",
        busy: Effect.succeed(false),
      }).pipe(test.provide)
      expect(result).toEqual({ type: "switched", from: "0.0.1", to: "0.0.2" })
      expect(yield* ReleaseLayout.current(test.switching.layout).pipe(test.provide)).toBe("0.0.2")
      expect((yield* reported(test.switching))?.version).toBe("0.0.2")
      expect(migrations(ReleaseSwitch.copyOf(test.switching, "0.0.1"))).toEqual(["m-0.0.1"])
      expect(migrations(test.switching.database)).toEqual(["m-0.0.1", "m-0.0.2"])
      expect(yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide)).toEqual({})
    }),
  )

  it.live("rolls back the link, the database and the service when the new service crashes", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.0.1", { version: "0.0.2", serve: "crash" })
      const result = yield* ReleaseSwitch.run(test.switching, {
        from: "0.0.1",
        to: "0.0.2",
        busy: Effect.succeed(false),
      }).pipe(test.provide)
      expect(result).toMatchObject({ type: "rolled-back", from: "0.0.1", to: "0.0.2", restored: true })
      if (result.type !== "rolled-back") return
      expect(result.reason).toContain("exited (code 3)")
      expect(result.reason).toContain("fake openforge 0.0.2 crashed on start")
      expect(yield* ReleaseLayout.current(test.switching.layout).pipe(test.provide)).toBe("0.0.1")
      expect((yield* reported(test.switching))?.version).toBe("0.0.1")
      // The crashed release had already migrated the database; the restored copy has no trace of it.
      expect(migrations(test.switching.database)).toEqual(["m-0.0.1"])
      const bad = yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide)
      expect(Object.keys(bad)).toEqual(["0.0.2"])
      expect(bad["0.0.2"].log).toBe(test.switching.log)
      const log = yield* Effect.promise(() => fs.readFile(test.switching.log, "utf8"))
      expect(log).toContain("0.0.1 -> 0.0.2: failed: ")
      expect(log).toContain("rolled back; the service reports 0.0.1")
    }),
  )

  it.live("rolls back when the new service answers with another version", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.0.1", { version: "0.0.2", serve: "wrong-version" })
      const result = yield* ReleaseSwitch.run(test.switching, {
        from: "0.0.1",
        to: "0.0.2",
        busy: Effect.succeed(false),
      }).pipe(test.provide)
      expect(result).toMatchObject({ type: "rolled-back", restored: true })
      expect(yield* ReleaseLayout.current(test.switching.layout).pipe(test.provide)).toBe("0.0.1")
      expect((yield* reported(test.switching))?.version).toBe("0.0.1")
      expect(migrations(test.switching.database)).toEqual(["m-0.0.1"])
    }),
  )

  it.live("restarts the old release, keeps its database and marks nothing bad when the copy fails", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.0.1", { version: "0.0.2" })
      const folder = ReleaseLayout.folder(test.switching.layout, "0.0.1")
      // Only the original database holds this row; a recreated one would not.
      writeMigrations(test.switching.database, ["user-data"])
      // The copy goes beside 0.0.1's binary; a read-only folder makes VACUUM INTO fail.
      yield* Effect.acquireRelease(
        Effect.promise(() => fs.chmod(folder, 0o555)),
        () => Effect.promise(() => fs.chmod(folder, 0o755)),
      )
      const result = yield* ReleaseSwitch.run(test.switching, {
        from: "0.0.1",
        to: "0.0.2",
        busy: Effect.succeed(false),
      }).pipe(test.provide)
      expect(result).toMatchObject({ type: "rolled-back", restored: true })
      if (result.type !== "rolled-back") return
      expect(result.reason).toStartWith("Could not use the database")
      expect(yield* ReleaseLayout.current(test.switching.layout).pipe(test.provide)).toBe("0.0.1")
      expect((yield* reported(test.switching))?.version).toBe("0.0.1")
      expect(migrations(test.switching.database)).toEqual(["m-0.0.1", "user-data"])
      expect(yield* ReleaseLayout.bad(test.switching.layout).pipe(test.provide)).toEqual({})
    }),
  )

  it.live("removes the database a failed release created when there was none before", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.0.1", { version: "0.0.2", serve: "crash" })
      yield* Effect.promise(() => fs.rm(test.switching.database))
      const result = yield* ReleaseSwitch.run(test.switching, {
        from: "0.0.1",
        to: "0.0.2",
        busy: Effect.succeed(false),
      }).pipe(test.provide)
      expect(result).toMatchObject({ type: "rolled-back", restored: true })
      // Only 0.0.1, started again, wrote to the database that is there now.
      expect(migrations(test.switching.database)).toEqual(["m-0.0.1"])
    }),
  )

  it.live("leaves everything alone when a chat started or another process already switched", () =>
    Effect.gen(function* () {
      const test = yield* installed("0.0.1", { version: "0.0.2" })
      const busy = yield* ReleaseSwitch.run(test.switching, {
        from: "0.0.1",
        to: "0.0.2",
        busy: Effect.succeed(true),
      }).pipe(test.provide)
      expect(busy).toEqual({ type: "busy" })
      expect((yield* reported(test.switching))?.version).toBe("0.0.1")
      yield* ReleaseLayout.point(test.switching.layout, "0.0.2").pipe(test.provide)
      const unchanged = yield* ReleaseSwitch.run(test.switching, {
        from: "0.0.1",
        to: "0.0.2",
        busy: Effect.succeed(false),
      }).pipe(test.provide)
      expect(unchanged).toEqual({ type: "unchanged", version: "0.0.2" })
      expect((yield* reported(test.switching))?.version).toBe("0.0.1")
      expect(yield* Effect.promise(() => fs.exists(ReleaseSwitch.copyOf(test.switching, "0.0.1")))).toBe(false)
    }),
  )
})

describe("waiting", () => {
  it.live("a starting service waits while another process holds the switch lock", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const done = yield* Deferred.make<void>()
      const layout = ReleaseLayout.at(path.join(directory, "data"))
      const flock = yield* EffectFlock.Service.pipe(Effect.provide(layer(directory)))
      const held = yield* Effect.forkChild(
        Effect.scoped(flock.acquire(SwitchLock.key, layout.locks).pipe(Effect.andThen(Effect.never))),
        { startImmediately: true },
      )
      yield* Effect.sleep("100 millis")
      const waiting = yield* SwitchLock.wait().pipe(
        Effect.andThen(Deferred.succeed(done, undefined)),
        Effect.provide(layer(directory)),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.sleep("500 millis")
      expect(yield* Deferred.isDone(done)).toBe(false)
      yield* Fiber.interrupt(held)
      yield* Fiber.join(waiting)
      expect(yield* Deferred.isDone(done)).toBe(true)
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
      yield* flock.acquire(SwitchLock.key, ReleaseLayout.at(path.join(directory, "data")).locks)
      yield* SwitchLock.wait().pipe(Effect.provide(layer(directory)), Effect.timeout("2 seconds"))
      expect(process.env[SwitchLock.variable]).toBeUndefined()
    }),
  )

  it.live("waits for the running chat to end, listening to the service's events", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const base = yield* target(directory)
      const switching = { ...base, service: { ...base.service, env: { ...base.service.env, FAKE_BUSY: "1" } } }
      yield* Effect.promise(() => keep(switching.layout, "0.0.1"))
      yield* ReleaseLayout.point(switching.layout, "0.0.1").pipe(Effect.provide(layer(directory)))
      const endpoint = yield* ReleaseSwitch.start(switching, "0.0.1").pipe(Effect.provide(layer(directory)))
      expect(yield* ReleaseSwitch.busy(switching).pipe(Effect.provide(layer(directory)))).toBe(true)
      const announced = yield* Deferred.make<void>()
      const idle = yield* ReleaseSwitch.idle(switching, () => Deferred.doneUnsafe(announced, Effect.void)).pipe(
        Effect.provide(layer(directory)),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(announced).pipe(Effect.timeout("5 seconds"))
      yield* Effect.promise(() => fetch(new URL("/fake/idle", endpoint.url)).then((response) => response.text()))
      yield* Fiber.join(idle).pipe(Effect.timeout("5 seconds"))
      expect(yield* ReleaseSwitch.busy(switching).pipe(Effect.provide(layer(directory)))).toBe(false)
    }),
  )
})
