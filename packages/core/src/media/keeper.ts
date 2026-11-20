export * as MediaKeeper from "./keeper.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Clock, Context, Effect, Layer } from "effect"
import { SessionContinuity } from "../continuity.js"
import { Database } from "../database/database.js"
import { KV } from "../kv.js"
import { MediaFiles } from "./files.js"
import { MediaMove } from "./move.js"

// openforge (spec pictures-files): the background work on a database's media files, in the service.

/** The `kv` key set once a database's media has all moved to files, so later starts skip the scan. */
export const MOVED = "media.moved"

export interface Interface {
  /**
   * Moves the media still in rows into files, once per database. Started once the service runs; while it is paused,
   * it waits before its next row.
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

    const move = Effect.gen(function* () {
      if (!folder || (yield* kv.get(MOVED)) !== undefined) return
      const started = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("moving stored media out of the database into files", { folder })
      const moved = yield* MediaMove.run(db, folder, continuity.awaitOpen)
      const at = yield* Clock.currentTimeMillis
      yield* kv.set(MOVED, { at, ...moved })
      yield* Effect.logInfo("moved stored media into files", { ...moved, ms: at - started })
    })

    return Service.of({
      run: move.pipe(
        Effect.catchCause((cause) => Effect.logError("could not move stored media into files", { cause })),
      ),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, KV.node, SessionContinuity.node],
})
