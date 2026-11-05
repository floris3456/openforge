import { NodeServices } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { EffectFlock } from "@opencode/util/effect-flock"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import path from "node:path"
import { testEffect } from "../../../core/test/lib/effect"
import { ServerConnection } from "../../src/services/server-connection"
import { ServiceConfig } from "../../src/services/service-config"
import { ReleaseLayout } from "../../src/upgrade/layout"
import { ReleaseSwitch } from "../../src/upgrade/switch"
import { SwitchLock } from "../../src/upgrade/switch-lock"
import { Updater } from "../../src/upgrade/updater"
import { happened, keep, layer, paths, root, target } from "./fixture/fixture"

const it = testEffect(NodeServices.layer)

// An install whose release switch is at the point where 0.1.1 is current and its service is yet to start. The client
// that connects runs another release (this test's, "local"); `starts` records each service it would start or replace,
// and it stops right there, before it does.
const install = Effect.gen(function* () {
  const directory = yield* root
  const base = yield* target(directory)
  // Where a client of this channel looks for the service.
  const file = path.join(paths(directory).state, ServiceConfig.filename())
  const switching = { ...base, service: { ...base.service, file, env: { ...base.service.env, FAKE_REGISTRATION: file } } }
  yield* Effect.addFinalizer(() => Service.stop({ file }).pipe(Effect.ignore))
  const provide = Effect.provide(layer(directory))
  yield* Effect.promise(() => keep(switching.layout, "0.1.1"))
  yield* ReleaseLayout.point(switching.layout, "0.1.1").pipe(provide)
  const updater = yield* Updater.make({
    data: paths(directory).data,
    config: paths(directory).config,
    log: paths(directory).log,
    version: "0.1.0",
    local: false,
    disabled: false,
    executable: "/nowhere/openforge",
    platform: "linux-x64",
    base: "http://127.0.0.1:9/releases",
    database: switching.database,
    service: Effect.succeed(switching.service),
    serviceDisabled: Effect.succeed(false),
  }).pipe(provide)
  const starts: string[] = []
  return {
    switching,
    provide,
    starts,
    happened: Effect.promise(() => happened(directory)),
    // As a process that switches releases holds it, until the test ends.
    lock: Effect.gen(function* () {
      const flock = yield* EffectFlock.Service.pipe(provide)
      const held = yield* Deferred.make<void>()
      yield* Effect.forkScoped(
        Effect.scoped(
          flock
            .acquire(SwitchLock.key, switching.layout.locks)
            .pipe(Effect.andThen(Deferred.succeed(held, undefined)), Effect.andThen(Effect.never)),
        ),
      )
      yield* Deferred.await(held)
    }),
    // A TUI or `openforge mini` starting: both replace a service of another version.
    connect: ServerConnection.resolve({
      mismatch: "replace",
      onStart: (reason) => {
        starts.push(reason)
        throw new Error(`the client would start a service (${reason})`)
      },
    }).pipe(Effect.provideService(Updater.Service, updater), provide),
  }
})

describe("a client that starts during a release switch", () => {
  it.live("takes the paused service the switch started, of another version, and replaces nothing", () =>
    Effect.gen(function* () {
      const test = yield* install
      yield* test.lock
      const started = yield* ReleaseSwitch.start(test.switching, "0.1.1").pipe(test.provide)
      const connected = yield* test.connect
      expect(test.starts).toEqual([])
      expect(connected.endpoint.url).toBe(started.endpoint.url)
      expect(yield* test.happened).toEqual(["0.1.1 started paused"])
    }),
  )

  it.live("waits for the service the switch starts when none is registered, and starts none of its own", () =>
    Effect.gen(function* () {
      const test = yield* install
      yield* test.lock
      const connecting = yield* test.connect.pipe(Effect.forkChild({ startImmediately: true }))
      const started = yield* ReleaseSwitch.start(test.switching, "0.1.1").pipe(test.provide)
      const connected = yield* Fiber.join(connecting).pipe(Effect.timeout("10 seconds"))
      expect(test.starts).toEqual([])
      expect(connected.endpoint.url).toBe(started.endpoint.url)
      expect(yield* test.happened).toEqual(["0.1.1 started paused"])
    }),
  )

  it.live("still replaces a service of another version when no switch runs", () =>
    Effect.gen(function* () {
      const test = yield* install
      yield* ReleaseSwitch.start(test.switching, "0.1.1").pipe(test.provide)
      expect(Exit.isFailure(yield* test.connect.pipe(Effect.exit))).toBe(true)
      expect(test.starts).toEqual(["version-mismatch"])
    }),
  )
})
