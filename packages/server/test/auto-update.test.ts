import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { AutoUpdate as AutoUpdateSchema } from "@opencode/schema/auto-update"
import { Duration, Effect, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { it } from "../../core/test/lib/effect"
import { AutoUpdate } from "../src/auto-update"

// Automatic updates' schedule (spec auto-update), under TestClock: a check when the service runs and every 15 minutes
// while the setting is `auto`, none otherwise, and a change applied without a restart. The driver stands for the CLI's:
// it counts the checks (each one request for release.json) and records the switches.

function fake(input: { policy: AutoUpdate.Policy; newer?: string; unavailable?: string }) {
  const state = {
    policy: input.policy,
    newer: input.newer,
    unavailable: input.unavailable,
    checks: 0,
    switches: [] as string[],
    failure: undefined as AutoUpdateSchema.Failure | undefined,
    // What the switch to a version leaves behind: a failure kept in upgrade.json.
    fails: new Set<string>(),
  }
  return Effect.gen(function* () {
    const changes = yield* Queue.unbounded<void>()
    const driver: AutoUpdate.Driver = {
      policy: Effect.sync(() => state.policy),
      write: (policy) => Effect.sync(() => void (state.policy = policy)),
      unavailable: Effect.sync(() => state.unavailable),
      newer: Effect.sync(() => {
        state.checks++
        return state.newer
      }),
      switch: (version) =>
        Effect.sync(() => {
          state.switches.push(version)
          if (state.fails.has(version)) state.failure = { version, message: "it exited (code 1)", at: state.switches.length }
        }),
      failure: Effect.sync(() => state.failure),
      changes: Stream.fromQueue(changes),
    }
    const service = yield* AutoUpdate.make(driver)
    return { state, service, edited: Queue.offer(changes, undefined) }
  })
}

// Lets the forked checks and the change handling take their turn.
const settle = Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true })
const minutes = (n: number) => TestClock.adjust(Duration.minutes(n)).pipe(Effect.andThen(settle))
const start = (service: AutoUpdate.Interface) =>
  service.run.pipe(Effect.forkChild({ startImmediately: true }), Effect.andThen(settle))

const bus = AppNodeBuilder.build(Bus.node)

describe("automatic updates", () => {
  it.effect("on: checks when the service runs and every 15 minutes", () =>
    Effect.gen(function* () {
      const { state, service } = yield* fake({ policy: "auto" })
      yield* start(service)
      expect(state.checks).toBe(1)
      yield* minutes(14)
      expect(state.checks).toBe(1)
      yield* minutes(1)
      expect(state.checks).toBe(2)
      yield* minutes(30)
      expect(state.checks).toBe(4)
    }).pipe(Effect.provide(bus)),
  )

  it.effect("off (notify or disable): no check at all, however long the service runs", () =>
    Effect.gen(function* () {
      for (const policy of ["notify", "disable"] as const) {
        const { state, service } = yield* fake({ policy, newer: "0.0.2" })
        yield* start(service)
        yield* minutes(24 * 60)
        expect(state.checks).toBe(0)
        expect((yield* service.status()).enabled).toBe(false)
      }
    }).pipe(Effect.provide(bus)),
  )

  it.effect("nothing checks before the service runs, as while it starts paused", () =>
    Effect.gen(function* () {
      const { state, service } = yield* fake({ policy: "notify" })
      yield* service.set(true)
      yield* minutes(60)
      expect(state.checks).toBe(0)
      yield* start(service)
      expect(state.checks).toBe(1)
    }).pipe(Effect.provide(bus)),
  )

  it.effect("turning it on checks at once and every 15 minutes; turning it off stops, without a restart", () =>
    Effect.gen(function* () {
      const { state, service } = yield* fake({ policy: "notify" })
      yield* start(service)
      expect(yield* service.set(true)).toMatchObject({ enabled: true })
      yield* settle
      expect(state.policy).toBe("auto")
      expect(state.checks).toBe(1)
      yield* minutes(15)
      expect(state.checks).toBe(2)
      // Turned on again: still one check every 15 minutes, not a second timer.
      yield* service.set(true)
      yield* minutes(15)
      expect(state.checks).toBe(3)
      expect(yield* service.set(false)).toMatchObject({ enabled: false })
      expect(state.policy).toBe("notify")
      yield* minutes(120)
      expect(state.checks).toBe(3)
    }).pipe(Effect.provide(bus)),
  )

  it.effect("an edit of the config file applies at once too", () =>
    Effect.gen(function* () {
      const { state, service, edited } = yield* fake({ policy: "notify" })
      yield* start(service)
      state.policy = "auto"
      yield* edited
      yield* settle
      expect(state.checks).toBe(1)
      state.policy = "disable"
      yield* edited
      yield* minutes(60)
      expect(state.checks).toBe(1)
    }).pipe(Effect.provide(bus)),
  )

  it.effect("where it can't update, it checks nothing and says why", () =>
    Effect.gen(function* () {
      const why = "This openforge runs from a source checkout. Install a release to upgrade it."
      const { state, service } = yield* fake({ policy: "auto", unavailable: why, newer: "0.0.2" })
      yield* start(service)
      yield* minutes(60)
      expect(state.checks).toBe(0)
      expect(yield* service.status()).toEqual({ enabled: true, unavailable: why, failure: undefined })
    }).pipe(Effect.provide(bus)),
  )

  it.effect("switches once to each new release", () =>
    Effect.gen(function* () {
      const { state, service } = yield* fake({ policy: "auto", newer: "0.0.2" })
      yield* start(service)
      yield* minutes(45)
      expect(state.checks).toBe(4)
      expect(state.switches).toEqual(["0.0.2"])
      state.newer = "0.0.3"
      yield* minutes(15)
      expect(state.switches).toEqual(["0.0.2", "0.0.3"])
    }).pipe(Effect.provide(bus)),
  )

  it.effect("a failed update is told once, and the status keeps it", () =>
    Effect.gen(function* () {
      const events = yield* Bus.Service
      const told: AutoUpdateSchema.Failure[] = []
      yield* events.subscribe(AutoUpdateSchema.Event.Failed).pipe(
        Stream.runForEach((event) => Effect.sync(() => told.push(event.data.failure))),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.yieldNow
      const { state, service } = yield* fake({ policy: "auto", newer: "0.0.2" })
      state.fails.add("0.0.2")
      yield* start(service)
      yield* minutes(45)
      const failure = { version: "0.0.2", message: "it exited (code 1)", at: 1 }
      expect((yield* service.status()).failure).toEqual(failure)
      state.newer = "0.0.3"
      yield* minutes(15)
      expect(told).toEqual([failure])
    }).pipe(Effect.provide(bus)),
  )
})
