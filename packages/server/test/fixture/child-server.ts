// A server in a process of its own, for tests whose servers share one database file. Two servers in the test's own
// process put two SQLite connections on one thread, and bun:sqlite waits out busy_timeout synchronously: the connection
// that holds the lock can't release it, and the thread stalls for 5 s. Separate processes, as real servers are, don't.
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Schema } from "effect"
import { HttpServer } from "effect/http"
import { ServerOptions } from "../../src/options"
import { ServerProcess } from "../../src/process"

/** Starts a server with `options` in a child process and answers its URL once it listens; the scope's end stops it. */
export const startChildServer = (options: ServerOptions) =>
  Effect.acquireRelease(
    Effect.promise(() => {
      const listening = Promise.withResolvers<string>()
      const child = Bun.spawn([process.execPath, import.meta.path, JSON.stringify(options)], {
        stdio: ["ignore", "ignore", "inherit"],
        ipc: (url) => listening.resolve(String(url)),
      })
      void child.exited.then((code) =>
        listening.reject(new Error(`the child server exited (${code}) before it listened`)),
      )
      return listening.promise.then((url) => ({ child, url }))
    }),
    (started) =>
      Effect.promise(() => {
        started.child.kill()
        return started.child.exited
      }),
  ).pipe(Effect.map((started) => started.url))

if (import.meta.main)
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const options = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ServerOptions))(process.argv[2])
      const server = yield* ServerProcess.start<never, never>(options)
      process.send?.(HttpServer.formatAddress(server.address))
      return yield* Effect.never
    }).pipe(
      Effect.scoped,
      // Its stdout (the server's log) is dropped; why it failed goes to the test's stderr.
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.sync(() => process.stderr.write(`${Cause.pretty(cause)}\n`)),
      ),
    ),
  )
