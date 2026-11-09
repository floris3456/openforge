import { AutoUpdate } from "../auto-update"
import { Effect } from "effect"

/** `update.*` in the `server.experimental` group: automatic updates of this service (spec auto-update). */
export const makeAutoUpdate = Effect.gen(function* () {
  const updates = yield* AutoUpdate.Service

  return {
    get: Effect.map(updates.status(), (data) => ({ data })),
    set: (enabled: boolean) => updates.set(enabled).pipe(Effect.orDie, Effect.map((data) => ({ data }))),
  }
})
