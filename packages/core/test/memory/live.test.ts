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
// `/pacer/v1/capabilities` and the memory routes, not `/v1/models`.

const url = process.env.MEMORY_LIVE_URL
const key = process.env.MEMORY_LIVE_KEY
const it = testEffect(Layer.empty)
const by = { role: "build", chat: "ses_memory_live" }
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

const ids = (found: { readonly entries: ReadonlyArray<{ readonly id: string }> }) =>
  found.entries.map((item) => item.id)

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

  it.live("writes, reads, finds, starts, replaces and forgets entries of one project", () =>
    Effect.gen(function* () {
      const live = yield* connect(key!)
      const project = `live-${random()}`
      const word = `zq${random()}`
      const verified = yield* live.client.write(project, {
        kind: "verified",
        text: `The ${word} service listens on port 7341.`,
        basis: "ss -ltn showed it",
        scope: "role",
        by,
      })
      const unverified = yield* live.client.write(project, {
        kind: "unverified",
        text: `The ${word} cache is rebuilt nightly.`,
        basis: "a comment in the cron file says so",
        scope: "global",
        by,
      })
      expect([verified.existing, unverified.existing]).toEqual([false, false])
      expect(verified.entry).toMatchObject({ kind: "verified", scope: "role", role: "build", by: { role: "build" } })
      expect(unverified.entry).toMatchObject({ kind: "unverified", scope: "global" })
      expect(yield* live.client.read(project, verified.entry.id)).toEqual(verified.entry)

      const scopes = { global: true, roles: ["build"] }
      const found = yield* live.client.search(project, { query: `${word} port`, scopes, limit: 5, by })
      console.log(`search meaning: ${found.meaning}`)
      expect(typeof found.meaning).toBe("boolean")
      expect(ids(found)).toContain(verified.entry.id)

      const started = yield* live.client.start(project, {
        prompt: `which port does ${word} use?`,
        scopes,
        limit: 5,
        by,
      })
      console.log(`start meaning: ${started.meaning}, counts: ${JSON.stringify(started.counts)}`)
      expect(ids(started)).toContain(verified.entry.id)
      expect(started.counts).toEqual({ global: 1, role: 1, task: 0 })

      const replacement = yield* live.client.write(project, {
        kind: "verified",
        text: `The ${word} service listens on port 7342.`,
        basis: "ss -ltn after the move",
        scope: "role",
        supersedes: verified.entry.id,
        by,
      })
      expect(replacement.entry.supersedes).toBe(verified.entry.id)
      expect((yield* live.client.read(project, verified.entry.id)).superseded_by).toBe(replacement.entry.id)
      const afterReplace = yield* live.client.search(project, { query: `${word} port`, scopes, limit: 20, by })
      expect(ids(afterReplace)).toContain(replacement.entry.id)
      expect(ids(afterReplace)).not.toContain(verified.entry.id)

      const forgotten = yield* live.client.forget(project, unverified.entry.id, { reason: "a live test", by })
      expect(forgotten).toMatchObject({ text: null, basis: null })
      const afterForget = yield* live.client.search(project, { query: `${word} cache nightly`, scopes, limit: 20, by })
      expect(ids(afterForget)).not.toContain(unverified.entry.id)
      // Nothing of it reaches another project.
      const elsewhere = yield* live.client.read(`${project}-other`, replacement.entry.id).pipe(Effect.flip)
      expect(elsewhere).toBeInstanceOf(MemoryClient.Missing)
    }),
  )

  it.live("turns an unknown id, the server's refusals and a wrong key into what an agent reads", () =>
    Effect.gen(function* () {
      const live = yield* connect(key!)
      const project = `live-${random()}`
      const missing = yield* live.client.read(project, "k3f9x2m7q4tz").pipe(Effect.flip)
      expect(missing).toBeInstanceOf(MemoryClient.Missing)
      expect(missing.message).toBe("There is no entry k3f9x2m7q4tz in this project's memory.")

      const long = yield* live.client
        .write(project, { kind: "unverified", text: "x".repeat(700), basis: "y".repeat(101), scope: "role", by })
        .pipe(Effect.flip)
      console.log(`over 800 characters: ${long.message}`)
      expect(long).toBeInstanceOf(MemoryClient.Refused)
      expect(long.message).toContain("800")

      const unseen = yield* live.client
        .write(project, { kind: "words", text: "zero\u200bwidth", scope: "role", by })
        .pipe(Effect.flip)
      console.log(`zero-width character: ${unseen.message}`)
      expect(unseen).toBeInstanceOf(MemoryClient.Refused)
      expect(unseen.message.toUpperCase()).toContain("200B")

      const stranger = yield* connect(`not-a-key-${random()}`)
      const refused = yield* stranger.client
        .search(project, { query: "q", scopes: "all", limit: 5, by })
        .pipe(Effect.flip)
      expect(refused).toBeInstanceOf(MemoryClient.Unavailable)
      expect(refused.message).toBe("Memory is unavailable right now, so the work goes on without it.")
    }),
  )
})
