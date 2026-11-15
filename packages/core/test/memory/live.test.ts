import { describe, expect } from "bun:test"
import { Context, Effect, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { MemoryClient } from "@opencode/core/memory/client"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { testEffect } from "../lib/effect"

// openforge's own memory client and capability decoder against a memory server running as its own process, over
// HTTP: CLIProxyPacer, or the small server's script mode. Skipped unless both are set:
//
//   MEMORY_LIVE_URL   the server's base URL, on loopback (the test harness refuses any other address), such as
//                     http://127.0.0.1:18451
//   MEMORY_LIVE_KEY   a client key the server knows
//
// From packages/core:
//
//   MEMORY_LIVE_URL=http://127.0.0.1:18451 MEMORY_LIVE_KEY=<key> /home/bliss/OpenForge/bin/bun run script/test.ts test/memory/live.test.ts
//
// Against the small server: `bun test/pacer/memory-server.ts --port 18451 --key <key>` in another shell. Every test
// works in a project of its own with a random part, so a server that already holds data needs no reset. It needs only
// `/pacer/v1/capabilities` and the memory routes a harness reads, not `/v1/models`.

const url = process.env.MEMORY_LIVE_URL
const key = process.env.MEMORY_LIVE_KEY
const it = testEffect(Layer.empty)
const random = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10)

/** The real PacerHttp and MemoryClient over an endpoint made of the URL and a key. */
const connect = Effect.fnUntraced(function* (apiKey: string) {
  const endpoint = PacerEndpoint.resolve({ baseURL: url, apiKey }, undefined)
  if (!endpoint) return yield* Effect.die(new Error(`not a base URL: ${url}`))
  const endpoints = yield* SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpoint)
  const http = Layer.fresh(PacerHttp.layer).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(
        PacerEndpoint.Service,
        PacerEndpoint.Service.of({
          get: () => SubscriptionRef.get(endpoints),
          changes: () => SubscriptionRef.changes(endpoints),
        }),
      ),
    ),
  )
  const context = yield* Layer.build(Layer.merge(http, Layer.fresh(MemoryClient.layer).pipe(Layer.provide(http))))
  return { http: Context.get(context, PacerHttp.Service), client: Context.get(context, MemoryClient.Service) }
})

describe.skipIf(!url || !key)("MemoryClient against a live server", () => {
  it.live("decodes capabilities with PacerModels' own decoder into a memory block of version 1", () =>
    Effect.gen(function* () {
      const live = yield* connect(key!)
      const answer = yield* live.http.get("/pacer/v1/capabilities", PacerModels.CapabilitiesAnswer)
      expect(answer.body.pacer).not.toBeNull()
      const memory = PacerModels.pacerOf(answer.body.pacer!).memory
      console.log("capabilities' memory block:", JSON.stringify(memory))
      expect(memory?.version).toBe(1)
      for (const limit of [memory!.entryCharacters, memory!.queryCharacters, memory!.searchLimit])
        expect(Number.isInteger(limit) && limit > 0).toBe(true)
      expect(memory!.embedding === null || typeof memory!.embedding === "string").toBe(true)
    }),
  )

  it.live("starts a chat with CPP's block, reads its place and memory's texts, in a project of its own", () =>
    Effect.gen(function* () {
      const live = yield* connect(key!)
      const project = `live-${random()}`
      const chat = live.client.withHeaders({
        "X-Pacer-Session": crypto.randomUUID(),
        "X-Pacer-Agent": "build",
        "X-Pacer-Chat": `ses_memory_live_${random()}`,
      })
      const started = yield* chat.start(project, {
        prompt: "where does the live test run?",
        limit: 5,
        tools: { recall: true, remember: true, task: true },
      })
      console.log("start block:", JSON.stringify(started.text))
      expect(started.text).not.toBe("")
      expect(started.place).toBeNull()
      expect(yield* chat.chat(project)).toEqual({ place: null, check: null })
      const texts = yield* live.client.texts()
      expect(texts.unavailable).not.toBe("")
      expect(texts.refused).not.toBe("")
    }),
  )

  it.live("turns a wrong key into memory unavailable", () =>
    Effect.gen(function* () {
      const wrong = yield* connect(`wrong-${random()}`)
      const refused = yield* wrong.client.texts().pipe(Effect.flip)
      expect(refused).toBeInstanceOf(MemoryClient.Unavailable)
    }),
  )
})
