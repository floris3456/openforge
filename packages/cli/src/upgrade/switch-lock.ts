// The lock that keeps release switches one at a time across every openforge process, kept apart from the switch
// itself so `serve --service` can wait for it without loading the client.

import { EffectFlock } from "@opencode/util/effect-flock"
import { Global } from "@opencode/util/global"
import { Duration, Effect } from "effect"
import path from "node:path"

export const key = "openforge-release-switch"
// Set only for the service a switch starts itself, so it does not wait for the switch's own lock.
export const variable = "OPENFORGE_UPGRADE_SWITCH"
export const timeout = Duration.minutes(10)

export function directory(data: string) {
  return path.join(data, "locks")
}

/**
 * Called by `serve --service` before it starts: while another process switches releases, wait for it to finish,
 * so a client reconnecting during the switch does not start the old release's service.
 */
export const wait = Effect.fn("upgrade.switch-lock.wait")(function* () {
  if (process.env[variable]) {
    delete process.env[variable]
    return
  }
  const flock = yield* EffectFlock.Service
  const global = yield* Global.Service
  yield* Effect.scoped(flock.acquire(key, directory(global.data), { timeoutMs: Duration.toMillis(timeout) })).pipe(
    Effect.catch((error) => Effect.logWarning("starting while a release switch still holds its lock", { error })),
  )
})

export * as SwitchLock from "./switch-lock"
