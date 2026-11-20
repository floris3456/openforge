export * as MediaKeeper from "./keeper.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { inArray } from "drizzle-orm"
import { Clock, Context, Duration, Effect, Layer } from "effect"
import { SessionContinuity } from "../continuity.js"
import { DatabaseBatch } from "../database/batch.js"
import { Database } from "../database/database.js"
import { KV } from "../kv.js"
import { BlobTable } from "../session/sql.js"
import { MediaExpiry } from "./expiry.js"
import { MediaFiles } from "./files.js"
import { MediaGate } from "./gate.js"
import { MediaMove } from "./move.js"
import { MediaWorker } from "./worker.js"

// openforge (spec pictures-files): the background work on a database's media, in the service.

/** The `kv` key set once a database's media has all moved to files, so later starts skip the scan. */
export const MOVED = "media.moved"

/** How old a file no row names, or a write or removal left behind, must be before the sweep deletes it. */
export const LEFTOVER_AGE = 24 * 60 * 60 * 1000

export interface Interface {
  /**
   * Removes the pictures of chats untouched for 30 days, moves the media still in rows into files (once per database),
   * and deletes leftover files; then again at the moment the next chat turns 30 days old. Started once the service
   * runs; while it is paused, it waits before its next chat or row.
   */
  readonly run: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MediaKeeper") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const kv = yield* KV.Service
    const continuity = yield* SessionContinuity.Service
    const folder = MediaFiles.folder(db)
    const database = MediaFiles.database(db)
    const between = continuity.awaitOpen

    const logged = <A>(what: string, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logError(`could not ${what}`, { cause }).pipe(Effect.as(undefined))),
      )

    // A round's work on the rows (task ze433w6fask0): on a worker thread over a connection of its own, so that it
    // never holds the service's thread; here when the database is no file or the worker can't start.
    const here: MediaWorker.Handle = {
      expire: (now) => MediaExpiry.run(db, folder, now, MediaGate.here(between)),
      move: () => (folder ? MediaMove.run(db, folder, MediaGate.here(between)) : Effect.succeed({ blobs: 0, rows: 0 })),
    }
    const rows = Effect.gen(function* () {
      if (!folder || !database) return here
      // Its writes hold the service's connection, the way a transaction of the service's holds it.
      return yield* MediaWorker.open({ database, folder }, db.$client.reserve).pipe(
        Effect.catch((error) =>
          Effect.logWarning("the media keeper works on the service's thread: its worker didn't start", {
            cause: String(error.cause),
          }).pipe(Effect.as(here)),
        ),
      )
    })

    // Before the move, so the pictures of chats already 30 days old are never written to files.
    const expire = (work: MediaWorker.Handle) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return yield* work.expire(now, between)
      })

    const move = (work: MediaWorker.Handle) =>
      Effect.gen(function* () {
        if (!folder || (yield* kv.get(MOVED)) !== undefined) return
        const started = yield* Clock.currentTimeMillis
        yield* Effect.logInfo("moving stored media out of the database into files", { folder })
        const moved = yield* work.move(between)
        const at = yield* Clock.currentTimeMillis
        yield* kv.set(MOVED, { at, ...moved })
        yield* Effect.logInfo("moved stored media into files", { ...moved, ms: at - started })
      })

    const sweep = Effect.gen(function* () {
      if (!folder) return
      const before = (yield* Clock.currentTimeMillis) - LEFTOVER_AGE
      const files = yield* Effect.promise(() => MediaFiles.list(folder))
      yield* Effect.forEach(files.leftovers, (file) => Effect.promise(() => MediaFiles.removeLeftover(file, before)), {
        discard: true,
      })
      for (const batch of DatabaseBatch.batches(files.hashes, 1)) {
        const named = new Set(
          (yield* db
            .select({ hash: BlobTable.hash })
            .from(BlobTable)
            .where(inArray(BlobTable.hash, batch))
            .all()
            .pipe(Effect.orDie)).map((row) => row.hash),
        )
        yield* Effect.forEach(
          batch.filter((hash) => !named.has(hash)),
          (hash) => Effect.promise(() => MediaFiles.remove(folder, hash, before)),
          { discard: true },
        )
      }
    })

    return Service.of({
      run: Effect.gen(function* () {
        const state = { first: true }
        // No polling: each round sleeps until the next chat turns 30 days old, or 30 days with no chat to wait for.
        while (true) {
          const next = yield* Effect.scoped(
            Effect.gen(function* () {
              const work = yield* rows
              const next = yield* logged("remove the pictures of chats untouched for 30 days", expire(work))
              if (state.first) yield* logged("move stored media into files", move(work))
              return next
            }),
          )
          state.first = false
          yield* logged("delete leftover media files", sweep)
          const now = yield* Clock.currentTimeMillis
          yield* Effect.sleep(Duration.millis(Math.max(0, (next ?? now + MediaExpiry.AGE) - now)))
          yield* between
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, KV.node, SessionContinuity.node],
})
