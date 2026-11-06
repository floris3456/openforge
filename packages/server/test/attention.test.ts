import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Effect, Schedule } from "effect"
import { HttpServer } from "effect/http"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

const authorization = `Basic ${btoa("opencode:secret")}`
const occurrence = {
  kind: "done",
  sessionID: "ses_attention",
  title: "Fix the build",
  message: "Session done",
  notify: true,
  sound: { name: "done" },
  focused: false,
} as const

const start = ServerProcess.start<never, never>({
  hostname: "127.0.0.1",
  port: 0,
  password: "secret",
  app: { version: "test-version" },
  database: { path: ":memory:" },
})

// A player follows the service; the TUI's report says which players are connected, so it leaves its sound and, for a
// player that shows desktop notifications, its own notification to them.
it.live("a report reaches every following player and says which kinds of player are connected", () =>
  Effect.gen(function* () {
    const server = yield* start
    const api = OpenCode.make({ baseUrl: HttpServer.formatAddress(server.address), headers: { authorization } })
    const report = () => Effect.promise(() => api.experimental.attention.occurrence(occurrence))

    expect(yield* report()).toEqual({ sound: false, desktop: false })

    const stop = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()))
    const follow = (desktop: boolean) =>
      api.experimental.attention.follow({ desktop }, { signal: stop.signal })[Symbol.asyncIterator]()
    const quiet = follow(false)
    expect((yield* Effect.promise(() => quiet.next())).value).toEqual({ type: "following", version: "test-version" })
    expect(yield* report()).toEqual({ sound: true, desktop: false })
    expect((yield* Effect.promise(() => quiet.next())).value).toEqual({ type: "occurrence", occurrence })

    const desktop = follow(true)
    expect((yield* Effect.promise(() => desktop.next())).value).toMatchObject({ type: "following" })
    expect(yield* report()).toEqual({ sound: true, desktop: true })
    for (const player of [quiet, desktop])
      expect((yield* Effect.promise(() => player.next())).value).toEqual({ type: "occurrence", occurrence })

    expect(yield* Effect.promise(() => api.experimental.attention.test({ kind: "question" }))).toEqual({
      sound: true,
      desktop: true,
    })
    for (const player of [quiet, desktop])
      expect((yield* Effect.promise(() => player.next())).value).toEqual({
        type: "occurrence",
        test: true,
        occurrence: {
          kind: "question",
          title: "openforge test",
          message: "A question waits for an answer",
          notify: true,
          sound: { name: "question" },
          focused: false,
        },
      })

    // A player that goes away no longer counts, once the service sees its stream close.
    stop.abort()
    const deadline = Date.now() + 10_000
    const answer = yield* report().pipe(
      Effect.repeat({
        until: (players) => !players.sound || Date.now() > deadline,
        schedule: Schedule.spaced("20 millis"),
      }),
    )
    expect(answer).toEqual({ sound: false, desktop: false })
  }),
)

it.live("a report with a field out of its bounds is refused", () =>
  Effect.gen(function* () {
    const server = yield* start
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/attention/occurrence", HttpServer.formatAddress(server.address)), {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ ...occurrence, message: "x".repeat(1001) }),
      }),
    )
    expect(response.status).toBe(400)
  }),
)
