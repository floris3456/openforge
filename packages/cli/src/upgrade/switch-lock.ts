// The lock that keeps release switches one at a time across every openforge process, kept apart from the switch
// itself so `serve --service` can wait for it without loading the client.

import { EffectFlock } from "@opencode/util/effect-flock"
import { Duration, Effect } from "effect"
import path from "node:path"

export const key = "openforge-release-switch"
// Set only for the service a switch starts itself, so it does not wait for the switch's own lock.
export const variable = "OPENFORGE_UPGRADE_SWITCH"
export const timeout = Duration.minutes(10)
// How long `held` tries for a lock that is free; a held one is never let go that quickly.
const probe = Duration.millis(100)

export function directory(data: string) {
  return path.join(data, "locks")
}

/**
 * While another process switches releases, waits for it to finish. A service started meanwhile (`serve --service`)
 * would be the old release's, and a client reconnecting meanwhile finds the new release's service once it is done.
 * `locks` is the lock folder (`directory`).
 */
export const wait = Effect.fn("upgrade.switch-lock.wait")(function* (locks: string) {
  if (process.env[variable]) {
    delete process.env[variable]
    return
  }
  const flock = yield* EffectFlock.Service
  yield* Effect.scoped(flock.acquire(key, locks, { timeoutMs: Duration.toMillis(timeout) })).pipe(
    Effect.catch((error) => Effect.logWarning("starting while a release switch still holds its lock", { error })),
  )
})

/** Whether another process is switching releases now: it holds the lock, which `held` takes and lets go when free. */
export const held = Effect.fn("upgrade.switch-lock.held")(function* (locks: string) {
  const flock = yield* EffectFlock.Service
  return yield* Effect.scoped(flock.acquire(key, locks, { timeoutMs: Duration.toMillis(probe) })).pipe(
    Effect.as(false),
    Effect.catchTag("LockTimeoutError", () => Effect.succeed(true)),
    // A lock folder this process can't write to shows no switch, and must not stop it from connecting.
    Effect.orElseSucceed(() => false),
    Effect.catchDefect(() => Effect.succeed(false)),
  )
})

export * as SwitchLock from "./switch-lock"
