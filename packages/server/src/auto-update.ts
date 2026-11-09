export * as AutoUpdate from "./auto-update"

import { Event, type Failure, type Status } from "@opencode/schema/auto-update"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Duration, Effect, Fiber, Layer, Scope, Semaphore, Stream } from "effect"
import { Bus } from "@opencode/core/bus"

// Automatic updates (spec auto-update). With the global config's `update` at `auto`, the background service checks
// for a newer release when it starts and every 15 minutes, and switches to it as `openforge upgrade` does. Otherwise
// it runs no timer and sends no request. A change of the setting applies at once. How a release is found, installed
// and switched to is the CLI's (`Driver`, packages/cli/src/upgrade/auto-update.ts, passed to `start`); a server without one, such as
// `opencode serve` or an embedded one, never updates itself.

export type Policy = "disable" | "notify" | "auto"

export const INTERVAL = Duration.minutes(15)

export interface Driver {
  /** The global config's `update`. */
  readonly policy: Effect.Effect<Policy>
  /** Writes the global config's `update`. */
  readonly write: (policy: "auto" | "notify") => Effect.Effect<void, Error>
  /** Why this service can't update itself, such as a source checkout; undefined when it can. */
  readonly unavailable: Effect.Effect<string | undefined>
  /** A release newer than the one in use that did not fail before, or undefined: one request for release.json. */
  readonly newer: Effect.Effect<string | undefined, Error>
  /**
   * Switches to `version` as `openforge upgrade` does, from a process that outlives this service, since the switch
   * stops it; succeeds once that process has ended. A failure rolls back and is kept as `failure`.
   */
  readonly switch: (version: string) => Effect.Effect<void, Error>
  /** The last automatic update that failed. */
  readonly failure: Effect.Effect<Failure | undefined>
  /** Each change of the global config's files, which may have changed `update`. */
  readonly changes: Stream.Stream<void>
  /** Between two checks; {@link INTERVAL} unless a test shortens it. */
  readonly interval?: Duration.Duration
}

export interface Interface {
  readonly status: () => Effect.Effect<Status>
  /** Turns automatic updates on (`auto`) or off (`notify`); applies at once. */
  readonly set: (enabled: boolean) => Effect.Effect<Status, Error>
  /** Checks while the setting is `auto`, and follows its changes. Started once the service runs, never while paused. */
  readonly run: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AutoUpdate") {}

const none: Interface = {
  status: () =>
    Effect.succeed({ enabled: false, unavailable: "This server does not update itself; only the background service does." }),
  set: () => Effect.fail(new Error("This server does not update itself; only the background service does.")),
  run: Effect.void,
}

export const make = Effect.fnUntraced(function* (driver: Driver) {
  const bus = yield* Bus.Service
  const scope = yield* Scope.Scope
  const lock = yield* Semaphore.make(1)
  const interval = driver.interval ?? INTERVAL
  // A release is switched to once per service: after a switch this service is gone, and a failed one is kept as bad.
  const tried = new Set<string>()
  const state: { started: boolean; ticker?: Fiber.Fiber<never>; told?: number } = {
    started: false,
    told: (yield* driver.failure)?.at,
  }

  const tell = Effect.gen(function* () {
    const failure = yield* driver.failure
    if (!failure || failure.at === state.told) return
    state.told = failure.at
    yield* bus.publish(Event.Failed, { failure })
  })

  const check = Effect.gen(function* () {
    const version = yield* driver.newer
    if (version === undefined || tried.has(version)) return
    tried.add(version)
    yield* Effect.logInfo("automatic update", { version })
    // Outlives a ticker that stops meanwhile, so the failure is still told.
    yield* driver.switch(version).pipe(
      Effect.catch((error) => Effect.logWarning("automatic update failed", { version, error })),
      Effect.andThen(tell),
      Effect.forkIn(scope),
    )
  }).pipe(Effect.catch((error) => Effect.logWarning("automatic update check failed", { error })))

  const ticker = check.pipe(Effect.andThen(Effect.sleep(interval)), Effect.forever)

  // Starts the checks when the setting turned `auto`, stops them when it turned anything else.
  const apply = lock.withPermits(1)(
    Effect.gen(function* () {
      if (!state.started) return
      const on = (yield* driver.policy) === "auto" && (yield* driver.unavailable) === undefined
      if (on && !state.ticker) state.ticker = yield* Effect.forkIn(ticker, scope)
      if (on || !state.ticker) return
      yield* Fiber.interrupt(state.ticker)
      state.ticker = undefined
    }),
  )

  const status = Effect.fnUntraced(function* () {
    return {
      enabled: (yield* driver.policy) === "auto",
      unavailable: yield* driver.unavailable,
      failure: yield* driver.failure,
    }
  })

  return Service.of({
    status,
    set: Effect.fnUntraced(function* (enabled) {
      yield* driver.write(enabled ? "auto" : "notify")
      yield* apply
      return yield* status()
    }),
    run: Effect.gen(function* () {
      state.started = true
      yield* apply
      yield* driver.changes.pipe(Stream.runForEach(() => apply))
    }),
  })
})

export const layer = (driver?: Driver) =>
  driver ? Layer.effect(Service, make(driver)) : Layer.succeed(Service, Service.of(none))

export const configured = (driver?: Driver) => makeGlobalNode({ service: Service, layer: layer(driver), deps: [Bus.node] })
export const node = configured()
