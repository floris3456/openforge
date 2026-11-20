export * as MediaWorker from "./worker.js"

import type { Worker } from "node:worker_threads"
import { Effect, Queue, Schema } from "effect"
import type { Reply, Request, Start } from "./media-worker.js"
import type { MediaMove } from "./move.js"

// openforge (task ze433w6fask0): the service's side of media-worker.ts, which does the media keeper's work on the rows
// on a thread of its own. Here only its questions are answered (Between, with `between`) and its log lines logged.

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("MediaWorker.UnavailableError", {
  cause: Schema.Defect(),
}) {}

/** How long a stopped worker gets to finish its statement and close its connection. */
const STOP_MILLIS = 5_000

export interface Handle {
  /** MediaExpiry.run on the worker's connection: when the next chat turns 30 days old. */
  readonly expire: (now: number, between: Effect.Effect<void>) => Effect.Effect<number | undefined>
  /** MediaMove.run on the worker's connection. */
  readonly move: (between: Effect.Effect<void>) => Effect.Effect<MediaMove.Moved>
}

/** Starts the worker on `start.database` and stops it when the scope closes. */
export const open = Effect.fnUntraced(function* (start: Start, url = new URL("./media-worker.js", import.meta.url)) {
  const worker = yield* Effect.acquireRelease(spawn(start, url), stop)
  return {
    expire: (now, between) =>
      request(worker, { _tag: "Expire", now }, between).pipe(
        Effect.flatMap((reply) =>
          reply._tag === "Expired" ? Effect.succeed(reply.next) : Effect.die(new Error(`unexpected ${reply._tag}`)),
        ),
      ),
    move: (between) =>
      request(worker, { _tag: "Move" }, between).pipe(
        Effect.flatMap((reply) =>
          reply._tag === "Moved" ? Effect.succeed(reply.moved) : Effect.die(new Error(`unexpected ${reply._tag}`)),
        ),
      ),
  } satisfies Handle
})

// Resolves once the worker has opened its connection; a worker that fails before that is unavailable.
const spawn = (start: Start, url: URL) =>
  Effect.tryPromise({
    try: async () => {
      const { Worker } = await import("node:worker_threads")
      const worker = new Worker(url, { workerData: start })
      await new Promise<void>((resolve, reject) => {
        worker.once("message", (reply: Reply) =>
          reply._tag === "Ready" ? resolve() : reject(new Error(reply._tag === "Failed" ? reply.message : reply._tag)),
        )
        worker.once("error", reject)
        worker.once("exit", (code) => reject(new Error(`the media worker exited with code ${code}`)))
      }).catch((cause: unknown) => {
        void worker.terminate()
        throw cause
      })
      worker.removeAllListeners()
      worker.once("exit", () => exited.add(worker))
      return worker
    },
    catch: (cause) => new UnavailableError({ cause }),
  })

const exited = new WeakSet<Worker>()

// Never terminated while it may hold a transaction: SQLite keeps the locks of a connection that was never closed, and
// the service's own connection would wait on them. A worker that doesn't stop in time is left to end with the process.
const stop = (worker: Worker) =>
  Effect.callback<void>((resume) => {
    if (exited.has(worker)) return resume(Effect.void)
    const timer = setTimeout(() => {
      worker.unref()
      resume(Effect.void)
    }, STOP_MILLIS)
    worker.once("exit", () => {
      clearTimeout(timer)
      resume(Effect.void)
    })
    worker.postMessage({ _tag: "Stop" } satisfies Request)
  })

type Event =
  | Reply
  | { readonly _tag: "Exit"; readonly code: number }
  | { readonly _tag: "Error"; readonly error: Error }

/** Sends one request and answers the worker's questions until its reply. */
const request = (worker: Worker, message: Request, between: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<Event>()
    const onMessage = (reply: Reply) => Queue.offerUnsafe(events, reply)
    const onExit = (code: number) => Queue.offerUnsafe(events, { _tag: "Exit", code })
    const onError = (error: Error) => Queue.offerUnsafe(events, { _tag: "Error", error })
    yield* Effect.acquireRelease(
      Effect.sync(() => worker.on("message", onMessage).on("exit", onExit).on("error", onError)),
      () => Effect.sync(() => worker.off("message", onMessage).off("exit", onExit).off("error", onError)),
    )
    worker.postMessage(message)
    while (true) {
      const event = yield* Queue.take(events)
      if (event._tag === "Between") {
        yield* between
        worker.postMessage({ _tag: "Go" } satisfies Request)
        continue
      }
      if (event._tag === "Log") {
        yield* Effect.logWithLevel(event.level)(...event.message)
        continue
      }
      if (event._tag === "Failed") return yield* Effect.die(new Error(event.message))
      if (event._tag === "Exit") return yield* Effect.die(new Error(`the media worker exited with code ${event.code}`))
      if (event._tag === "Error") return yield* Effect.die(event.error)
      if (event._tag === "Expired" || event._tag === "Moved") return event
    }
  }).pipe(Effect.scoped)
