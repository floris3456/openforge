import { parentPort, workerData } from "node:worker_threads"
import { sqliteLayer } from "#sqlite"
import { Cause, Deferred, Effect, Exit, Logger, Queue, Schedule } from "effect"
import type { LogLevel } from "effect"
import { EffectDrizzleSqlite } from "../database/drizzle.js"
import { MediaExpiry } from "./expiry.js"
import { MediaFiles } from "./files.js"
import type { MediaGate } from "./gate.js"
import { MediaMove } from "./move.js"

// openforge (task ze433w6fask0): the media keeper's work on a database's rows, the 30-day removal and the move into
// files, on a thread of its own over its own connection to the database file. Reading and rewriting large rows,
// hashing their bytes and the garbage that leaves never hold the service's thread. Before each chat or row it asks
// (Between) and waits for Go, which the service sends once it is open, so a pause holds the work and a busy service
// slows it. Around each write it asks for the database (Lock) and waits for Locked, which the service sends once it
// holds its own connection, until Unlock (MediaGate). The service starts it with `workerData` and sends one request at
// a time; Stop ends the request under way between two statements and closes the connection, so the worker never
// leaves a transaction or a lock behind. While it runs, it checkpoints the database and the service's connection
// doesn't (MediaKeeper): a checkpoint syncs the database file, which on a busy disk took the service's thread seconds
// while the move wrote its files. A checkpoint beside the service's readers can't let the WAL start over, so it grows
// while the worker writes (to 925 MB in 180 s of the move beside 10 chats); the worker truncates it while it holds the
// service's connection, when it passes WAL_LIMIT and when a request ends.

export type Start = { readonly database: string; readonly folder: string }
export type Request =
  | { readonly _tag: "Expire"; readonly now: number }
  | { readonly _tag: "Move" }
  | { readonly _tag: "Go" }
  | { readonly _tag: "Locked" }
  | { readonly _tag: "Stop" }
export type Reply =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Between" }
  | { readonly _tag: "Lock" }
  | { readonly _tag: "Unlock" }
  | { readonly _tag: "Expired"; readonly next: number | undefined }
  | { readonly _tag: "Moved"; readonly moved: MediaMove.Moved }
  | { readonly _tag: "Log"; readonly level: LogLevel.Severity; readonly message: ReadonlyArray<unknown> }
  | { readonly _tag: "Failed"; readonly message: string }

/** How often the worker checkpoints the database while it runs. */
const CHECKPOINT_MILLIS = 500

/**
 * The WAL's size past which the worker truncates it before the request ends. A truncation holds the service's
 * connection while it syncs the database file, so this bounds a long move rather than setting a pace: 256 MB came
 * every 50 s or so beside 10 chats.
 */
const WAL_LIMIT = 1024 * 1024 * 1024

const port = parentPort
if (port) {
  const start = workerData as Start
  const post = (reply: Reply) => port.postMessage(reply)
  const stopped = Deferred.makeUnsafe<void>()
  // Its log lines go to the service's log.
  const forward = Logger.make((options) => {
    if (options.logLevel === "All" || options.logLevel === "None") return
    post({
      _tag: "Log",
      level: options.logLevel,
      message: (Array.isArray(options.message) ? options.message : [options.message]).map((part) =>
        typeof part === "object" && part !== null ? JSON.parse(JSON.stringify(part)) : part,
      ),
    })
  })
  const work = Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    // The service's connection ran the migrations and set the file's journal mode; these two are per connection.
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_autocheckpoint = 0")
    // PASSIVE waits for no reader or writer, so the service's statements go on beside it.
    yield* db
      .run("PRAGMA wal_checkpoint(PASSIVE)")
      .pipe(Effect.ignore, Effect.repeat(Schedule.spaced(CHECKPOINT_MILLIS)), Effect.forkScoped)
    MediaFiles.register(db, start.folder, start.database)
    const requests = yield* Queue.unbounded<Request>()
    // The service's answers, Go and Locked: the worker waits for one at a time.
    const answers = yield* Queue.unbounded<Request>()
    port.on("message", (request: Request) => {
      if (request._tag === "Stop") {
        Deferred.doneUnsafe(stopped, Exit.void)
        return
      }
      Queue.offerUnsafe(request._tag === "Go" || request._tag === "Locked" ? answers : requests, request)
    })
    const ask = (question: Reply) => Effect.sync(() => post(question)).pipe(Effect.andThen(Queue.take(answers)))
    // While the worker holds the service's connection no reader uses the WAL, so TRUNCATE neither waits nor fails.
    const truncate = db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.ignore)
    const wal = `${start.database}-wal`
    const write: MediaGate.Interface["write"] = (effect) =>
      Effect.acquireUseRelease(
        ask({ _tag: "Lock" }),
        () => effect,
        () => Effect.sync(() => post({ _tag: "Unlock" })),
      )
    const gate: MediaGate.Interface = {
      between: ask({ _tag: "Between" }).pipe(Effect.asVoid),
      write: (effect) =>
        write(effect.pipe(Effect.tap(() => (Bun.file(wal).size > WAL_LIMIT ? truncate : Effect.void)))),
    }
    post({ _tag: "Ready" })
    while (true) {
      const request = yield* Queue.take(requests)
      if (request._tag === "Expire") {
        const next = yield* MediaExpiry.run(db, start.folder, request.now, gate)
        yield* write(truncate)
        post({ _tag: "Expired", next })
      }
      if (request._tag === "Move") {
        const moved = yield* MediaMove.run(db, start.folder, gate)
        yield* write(truncate)
        post({ _tag: "Moved", moved })
      }
    }
  })
  void Effect.runPromise(
    Effect.raceFirst(work, Deferred.await(stopped)).pipe(
      Effect.scoped,
      Effect.provide(sqliteLayer({ filename: start.database })),
      Effect.catchCause((cause) => Effect.sync(() => post({ _tag: "Failed", message: Cause.pretty(cause) }))),
      Effect.provide(Logger.layer([forward], { mergeWithExisting: false })),
    ),
  ).then(() => port.close())
}
