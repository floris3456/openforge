export * as ContinuityCommand from "./command.js"

import { Cause, Clock, Effect, Option, Schema } from "effect"
import type { KV } from "../kv.js"

const PREFIX = "session.command/"
// Longer than a client resends a write, which is 2 minutes.
const KEPT = 10 * 60_000
// Ids looked at for expiry on each command; the oldest come first, as message ids grow with time.
const SWEPT = 1_000

const Marker = Schema.Struct({ at: Schema.Number })
const decodeMarker = Schema.decodeUnknownOption(Marker)

/**
 * Runs a command given an id once: the same id again does nothing. A client sends a command again with its id when
 * the connection dropped after the request went out, as when a release switch stops the service that may have taken
 * it. The id is marked before the command runs, so a resend while it runs, or after a stop cut it off, does not run
 * it again; a command that fails can be sent again. Ids are kept for 10 minutes, in the database the next release
 * starts from.
 */
export const once =
  (kv: KV.Interface, id: string | undefined) =>
  <E, R>(run: Effect.Effect<void, E, R>) =>
    Effect.gen(function* () {
      if (id === undefined) return yield* run
      const key = PREFIX + id
      if ((yield* kv.get(key)) !== undefined) return
      const now = yield* Clock.currentTimeMillis
      yield* kv.set(key, { at: now })
      yield* run.pipe(Effect.onError((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : kv.remove(key))))
      const kept = yield* kv.scan({ prefix: PREFIX, limit: SWEPT })
      yield* Effect.forEach(
        kept.entries.filter((entry) =>
          Option.match(decodeMarker(entry.value), { onNone: () => true, onSome: (marker) => marker.at <= now - KEPT }),
        ),
        (entry) => kv.remove(entry.key),
        { discard: true },
      )
    })
