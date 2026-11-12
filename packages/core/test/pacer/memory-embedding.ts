/**
 * A fake OpenAI-style embedding endpoint (`POST /v1/embeddings`) for the memory tests, on `Bun.serve`. Its vectors are
 * deterministic and carry meaning without shared words: one axis per concept of `CONCEPTS`, holding how many of the
 * text's words belong to it, and a last axis of 0.1 so that no vector is zero. It answers `data` in reverse order, so a
 * server that ignores `index` gets the vectors wrong.
 */

export const CONCEPTS = [
  ["picture", "image", "photo", "screenshot"],
  ["terminal", "console", "shell", "tty"],
  ["database", "sqlite", "table", "storage"],
  ["network", "socket", "port", "http"],
  ["release", "deploy", "publish", "ship"],
]

export function vectorOf(text: string) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return [...CONCEPTS.map((concept) => words.filter((word) => concept.includes(word)).length), 0.1]
}

export type EmbeddingCall = { readonly model: unknown; readonly authorization: string | null; readonly input: string[] }

/** `fail` answers 503 and `delay` waits that many milliseconds before answering; both are read when a call arrives. */
export type FakeEmbedding = {
  readonly url: string
  readonly calls: EmbeddingCall[]
  fail: boolean
  delay: number
  readonly stop: () => Promise<void>
}

export function startFakeEmbedding(input: { readonly port?: number } = {}) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 0,
    routes: {
      "/v1/embeddings": {
        POST: async (request) => {
          const body = (await request.json()) as { model: unknown; input: string[] }
          const failing = fake.fail
          const delay = fake.delay
          fake.calls.push({ model: body.model, authorization: request.headers.get("authorization"), input: body.input })
          if (delay) await Bun.sleep(delay)
          if (failing) return Response.json({ error: { message: "failing on purpose" } }, { status: 503 })
          return Response.json({
            object: "list",
            model: body.model,
            data: body.input
              .map((text, index) => ({ object: "embedding", index, embedding: vectorOf(text) }))
              .toReversed(),
          })
        },
      },
    },
    fetch: () => Response.json({ error: { message: "not found" } }, { status: 404 }),
  })
  const fake: FakeEmbedding = {
    url: `http://127.0.0.1:${server.port}/v1`,
    calls: [],
    fail: false,
    delay: 0,
    stop: () => server.stop(true),
  }
  return fake
}
