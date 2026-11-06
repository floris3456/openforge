import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// A location's integrations come from its plugins, which activate once its first request has arrived. The integration
// routes wait for them: a login sent as a new location's first request used to be told the integration did not exist.

it.live("a login sent as a new location's first request connects", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-integration-location-")))
    const global = path.join(tmp.path, "global")
    yield* Effect.promise(() => fs.mkdir(global))
    const handler = yield* ServerFetch.make({
      database: { path: ":memory:" },
      config: { directory: global },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    // Each call to `call` with a new folder is that location's first request.
    const call = (folder: string, method: "GET" | "POST", route: string, body?: unknown) =>
      Effect.promise(async () => {
        const directory = path.join(tmp.path, folder)
        await fs.mkdir(directory)
        const url = new URL(route, "http://opencode.local")
        url.searchParams.set("location[directory]", directory)
        const response = await handler(
          new Request(url, {
            method,
            headers: body === undefined ? {} : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : undefined }
      })

    // Upstream's providers and CLIProxyPacer alike.
    expect(yield* call("anthropic", "POST", "/api/integration/anthropic/connect/key", { key: "made-up-key" })).toEqual({
      status: 204,
      body: undefined,
    })
    expect(
      yield* call("cliproxypacer", "POST", "/api/integration/cliproxypacer/connect/key", {
        key: "made-up-key",
        answer: { baseURL: "http://127.0.0.1:9" },
      }),
    ).toEqual({ status: 204, body: undefined })

    // A read sent as the first request finds the integration, with the key the login stored.
    const read = yield* call("read", "GET", "/api/integration/cliproxypacer")
    expect(read.status).toBe(200)
    expect(read.body.data.connections).toMatchObject([{ type: "credential", method: "key" }])
  }),
)
