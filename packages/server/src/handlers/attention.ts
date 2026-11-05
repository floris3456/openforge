import { Attention } from "@opencode/schema/attention"
import { Product } from "@opencode/schema/product"
import { Effect, Queue, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import { ServerInfo } from "../server-info"

// A player that falls this far behind loses the newest occurrences rather than holding up the TUI that reports them.
const PLAYER_BACKLOG = 64

const TEST_MESSAGES: Record<(typeof Attention.testKinds)[number], string> = {
  done: "Test: a chat is done",
  subagent_done: "Test: a subagent is done",
  question: "Test: a question waits for an answer",
  permission: "Test: a permission waits for an answer",
  error: "Test: a chat failed",
}

/**
 * `attention.*` in the `server.experimental` group: TUIs report the notifications they show, and the players that
 * follow this service (`openforge notify`) get each one. Only the connected players are kept; with none, a report
 * costs nothing but its answer.
 */
export const makeAttention = Effect.sync(() => {
  // Each player's queue, and whether it shows desktop notifications.
  const players = new Map<Queue.Queue<string>, boolean>()
  const connected = (): Attention.Players => ({
    sound: players.size > 0,
    desktop: Array.from(players.values()).some(Boolean),
  })
  const deliver = (event: Attention.FollowEvent) => {
    if (players.size === 0) return
    const encoded = frame(event)
    for (const queue of players.keys()) Queue.offerUnsafe(queue, encoded)
  }

  return {
    occurrence: (occurrence: Attention.Occurrence) =>
      Effect.sync(() => {
        deliver({ type: "occurrence", occurrence })
        return { data: connected() }
      }),
    test: (kind: (typeof Attention.testKinds)[number]) =>
      Effect.sync(() => {
        deliver({
          type: "occurrence",
          test: true,
          occurrence: {
            kind,
            title: Product.name,
            message: TEST_MESSAGES[kind],
            notify: true,
            sound: { name: kind },
            focused: false,
          },
        })
        return { data: connected() }
      }),
    follow: (desktop: boolean) =>
      Effect.gen(function* () {
        const info = yield* ServerInfo.Service
        const events = Stream.unwrap(
          Effect.acquireRelease(
            Queue.dropping<string>(PLAYER_BACKLOG).pipe(
              Effect.tap((queue) => Effect.sync(() => players.set(queue, desktop))),
            ),
            (queue) =>
              Effect.sync(() => players.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
          ).pipe(
            Effect.map((queue) =>
              Stream.make(frame({ type: "following", version: info.app.version ?? "unknown" })).pipe(
                Stream.concat(Stream.fromQueue(queue)),
              ),
            ),
          ),
        )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
  }
})

function frame(event: Attention.FollowEvent) {
  return `data: ${JSON.stringify(event)}\n\n`
}
