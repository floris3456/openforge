import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { PacerModels } from "@opencode/core/pacer/models"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Deferred, Effect, Layer, Stream } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// The server runs the connection to CPP; with no CPP set up it answers as such. The routes' answers with CPP are tested
// with the connection, against a fake CPP (core's test/pacer/connection.test.ts).

const server = Effect.fnUntraced(function* (overrides: LayerNode.Replacements = []) {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-pacer-endpoint-")))
  const global = path.join(tmp.path, "global")
  yield* Effect.promise(() => fs.mkdir(global))
  const handler = yield* ServerFetch.make(
    {
      database: { path: ":memory:" },
      config: { directory: global },
      fs: { filewatcher: false },
      models: { fetch: false },
    },
    { overrides },
  )
  return (route: string, init?: RequestInit) =>
    Effect.promise(async () => {
      const response = await handler(new Request(new URL(route, "http://opencode.local"), init))
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    })
})

it.live("answers as not set up without a connection to CPP", () =>
  Effect.gen(function* () {
    const call = yield* server()

    const status = yield* call("/api/experimental/pacer/status")
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ data: { state: "unset", refused: false } })
    expect(typeof status.body.data.since).toBe("number")

    expect(yield* call("/api/experimental/pacer/accounts")).toEqual({ status: 200, body: { data: null } })
    expect(yield* call("/api/experimental/pacer/chat/ses_pacer_test")).toEqual({ status: 200, body: { data: null } })
    expect(yield* call("/api/experimental/pacer/refresh", { method: "POST" })).toEqual({ status: 204, body: undefined })

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
    const call = yield* server()

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

it.live("starts one read of CPP's models at a time and answers before it ends", () =>
  Effect.gen(function* () {
    // A catalog whose reads take until the test lets them end.
    const reads = { started: 0, ended: 0 }
    const release = yield* Deferred.make<void>()
    const models = PacerModels.Service.of({
      get: () => Effect.succeed(undefined),
      changes: () => Stream.make(undefined),
      refresh: () =>
        Effect.gen(function* () {
          reads.started++
          yield* Deferred.await(release)
          reads.ended++
        }),
    })
    const call = yield* server([
      PacerModels.node.replace(
        makeGlobalNode({ service: PacerModels.Service, layer: Layer.succeed(PacerModels.Service, models), deps: [] }),
      ),
    ])
    const refresh = call("/api/experimental/pacer/refresh", { method: "POST" })
    expect(reads).toEqual({ started: 0, ended: 0 })

    expect(yield* refresh).toEqual({ status: 204, body: undefined })
    expect(reads).toEqual({ started: 1, ended: 0 })
    // A second call while the first read runs starts none.
    expect(yield* refresh).toEqual({ status: 204, body: undefined })
    expect(reads).toEqual({ started: 1, ended: 0 })

    // The read goes on after its request was answered.
    yield* Deferred.succeed(release, undefined)
    while (reads.ended < 1) yield* Effect.sleep("5 millis")
    expect(reads).toEqual({ started: 1, ended: 1 })
    // Once it ended, the next call reads again.
    expect(yield* refresh).toEqual({ status: 204, body: undefined })
    while (reads.ended < 2) yield* Effect.sleep("5 millis")
    expect(reads).toEqual({ started: 2, ended: 2 })
  }),
)
