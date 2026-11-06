import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// Until the connection's node is registered, the server has no connection to CPP and answers as one where CPP is not
// set up. The routes with a connection are tested with the connection.

const server = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-pacer-endpoint-")))
  const global = path.join(tmp.path, "global")
  yield* Effect.promise(() => fs.mkdir(global))
  const handler = yield* ServerFetch.make({
    database: { path: ":memory:" },
    config: { directory: global },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return (route: string, init?: RequestInit) =>
    Effect.promise(async () => {
      const response = await handler(new Request(new URL(route, "http://opencode.local"), init))
      return { status: response.status, body: await response.json() }
    })
})

it.live("answers as not set up without a connection to CPP", () =>
  Effect.gen(function* () {
    const call = yield* server

    const status = yield* call("/api/experimental/pacer/status")
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ data: { state: "unset", refused: false } })
    expect(typeof status.body.data.since).toBe("number")

    expect(yield* call("/api/experimental/pacer/accounts")).toEqual({ status: 200, body: { data: null } })
    expect(yield* call("/api/experimental/pacer/chat/ses_pacer_test")).toEqual({ status: 200, body: { data: null } })

    for (const [route, init] of [
      [
        "/api/experimental/pacer/chat/ses_pacer_test",
        { method: "PATCH", body: JSON.stringify({ warming: false }), headers: { "content-type": "application/json" } },
      ],
      ["/api/experimental/pacer/chat/ses_pacer_test/requests?filter=misses", undefined],
      ["/api/experimental/pacer/prompt/req-1", undefined],
    ] as const) {
      const result = yield* call(route, init)
      expect(result.status).toBe(503)
      expect(result.body).toMatchObject({ _tag: "ServiceUnavailableError", service: "cliproxypacer" })
    }
  }),
)

it.live("rejects malformed pacer requests", () =>
  Effect.gen(function* () {
    const call = yield* server

    expect((yield* call("/api/experimental/pacer/chat/not-a-session")).status).toBe(400)
    expect((yield* call("/api/experimental/pacer/chat/ses_pacer_test/requests?limit=0")).status).toBe(400)
    expect((yield* call("/api/experimental/pacer/chat/ses_pacer_test/requests?filter=hits")).status).toBe(400)
    const update = yield* call("/api/experimental/pacer/chat/ses_pacer_test", {
      method: "PATCH",
      body: JSON.stringify({ warming: "yes" }),
      headers: { "content-type": "application/json" },
    })
    expect(update.status).toBe(400)
  }),
)
