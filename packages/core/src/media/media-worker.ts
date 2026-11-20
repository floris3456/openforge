import { parentPort, workerData } from "node:worker_threads"
import { sqliteLayer } from "#sqlite"
import { Cause, Deferred, Effect, Exit, Logger, Queue } from "effect"
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
// leaves a transaction or a lock behind.

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
    const gate: MediaGate.Interface = {
      between: ask({ _tag: "Between" }).pipe(Effect.asVoid),
      write: (effect) =>
        Effect.acquireUseRelease(
          ask({ _tag: "Lock" }),
          () => effect,
          () => Effect.sync(() => post({ _tag: "Unlock" })),
        ),
    }
    post({ _tag: "Ready" })
    while (true) {
      const request = yield* Queue.take(requests)
      if (request._tag === "Expire")
        post({ _tag: "Expired", next: yield* MediaExpiry.run(db, start.folder, request.now, gate) })
      if (request._tag === "Move") post({ _tag: "Moved", moved: yield* MediaMove.run(db, start.folder, gate) })
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
