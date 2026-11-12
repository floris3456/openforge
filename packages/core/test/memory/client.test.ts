import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { MemoryClient } from "@opencode/core/memory/client"
import { Project } from "@opencode/core/project"
import { Document, Info } from "@opencode/schema/config"
import { ConfigMemory } from "@opencode/schema/config/memory"
import { testEffect } from "../lib/effect"
import { until } from "../pacer/fake-tools"
import { endpointAt, key, memoryServer, nearServer, startClient } from "./fixture"

const it = testEffect(Layer.empty)
const project = "client-project"
const by = { role: "build", chat: "ses_client" }

const setup = Effect.gen(function* () {
  const server = yield* memoryServer
  const started = yield* startClient(endpointAt(server.origin))
  return { server, client: started.client }
})

describe("MemoryClient", () => {
  it.live("writes, reads, searches, starts and forgets an entry of one project", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const written = yield* h.client.write(project, {
        kind: "verified",
        text: "The workspace repository has no git remote.",
        basis: "git remote -v printed nothing",
        scope: "role",
        by,
      })
      expect(written.existing).toBe(false)
      expect(written.entry).toMatchObject({ kind: "verified", scope: "role", role: "build", by: { person: "floris" } })
      expect(yield* h.client.read(project, written.entry.id)).toEqual(written.entry)
      const found = yield* h.client.search(project, {
        query: "git remote",
        scopes: { global: true, roles: ["build"] },
        limit: 5,
        by,
      })
      expect(found.entries.map((entry) => entry.id)).toEqual([written.entry.id])
      expect(found.meaning).toBe(false)
      const started = yield* h.client.start(project, {
        prompt: "does the repository have a remote?",
        scopes: { global: true, roles: ["build"] },
        limit: 5,
        by,
      })
      expect(started.counts).toEqual({ global: 0, role: 1, task: 0 })
      const forgotten = yield* h.client.forget(project, written.entry.id, { reason: "a test", by })
      expect(forgotten.text).toBeNull()
      // Another project holds none of it.
      expect((yield* h.client.read("other-project", written.entry.id).pipe(Effect.flip))._tag).toBe(
        "MemoryClient.Missing",
      )
    }),
  )

  it.live(
    "answers a write's near entries with their scores, none for a copy, and none from a server without near",
    () =>
      Effect.gen(function* () {
        const server = yield* nearServer
        const client = (yield* startClient(endpointAt(server.origin))).client
        const photo = yield* client.write(project, {
          kind: "verified",
          text: "A photo.",
          basis: "seen",
          scope: "role",
          by,
        })
        expect(photo.near).toEqual([])
        const picture = { kind: "verified", text: "A picture.", basis: "seen", scope: "role", by } as const
        const written = yield* client.write(project, picture)
        expect(written.near).toEqual([{ ...photo.entry, score: expect.closeTo(1, 4) }])
        expect((yield* client.write(project, picture)).near).toEqual([])

        // An older server answers no near.
        server.control.answer = async (request) => {
          const answer = await fetch(`${server.store.url}${request.path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify(request.body),
          })
          const body = (await answer.json()) as { entry: unknown }
          return Response.json({ entry: body.entry }, { status: answer.status })
        }
        const older = yield* client.write(project, { ...picture, text: "An image." })
        expect(older).toEqual({ entry: expect.objectContaining({ text: "An image." }), existing: false, near: [] })
      }),
  )

  it.live("passes the server's 400 and 409 messages on as they are, and reads a 404 on an entry as missing", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const long = yield* h.client
        .write(project, { kind: "unverified", text: "x".repeat(700), basis: "y".repeat(101), scope: "role", by })
        .pipe(Effect.flip)
      expect(long).toBeInstanceOf(MemoryClient.Refused)
      expect(long.message).toBe("text: text and basis together have 801 characters, more than 800")

      const unseen = yield* h.client
        .write(project, { kind: "words", text: "a\u200bb", scope: "role", by })
        .pipe(Effect.flip)
      expect(unseen.message).toStartWith("text: refused character U+200B at position 2")

      const first = yield* h.client.write(project, { kind: "words", text: "Keep it simple.", scope: "role", by })
      const second = yield* h.client.write(project, {
        kind: "words",
        text: "Keep it simpler.",
        scope: "role",
        supersedes: first.entry.id,
        by,
      })
      const again = yield* h.client
        .write(project, { kind: "words", text: "Simplest.", scope: "role", supersedes: first.entry.id, by })
        .pipe(Effect.flip)
      expect(again).toBeInstanceOf(MemoryClient.Refused)
      expect(again.message).toBe(`supersedes: entry ${first.entry.id} is already replaced by ${second.entry.id}`)

      const missing = yield* h.client.read(project, "k3f9x2m7q4tz").pipe(Effect.flip)
      expect(missing).toBeInstanceOf(MemoryClient.Missing)
      expect(missing.message).toBe("There is no entry k3f9x2m7q4tz in this project's memory.")
      expect((yield* h.client.forget(project, "k3f9x2m7q4tz", { reason: "r", by }).pipe(Effect.flip))._tag).toBe(
        "MemoryClient.Missing",
      )
    }),
  )

  it.live("is unavailable when not set up, unreachable, refused, a plain proxy, or busy", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const search = (client: MemoryClient.Interface) =>
        client.search(project, { query: "q", scopes: "all", limit: 5, by }).pipe(Effect.flip)
      const unavailable = (error: MemoryClient.Error) => {
        expect(error).toBeInstanceOf(MemoryClient.Unavailable)
        expect(error.message).toBe("Memory is unavailable right now, so the work goes on without it.")
      }

      unavailable(yield* search((yield* startClient(undefined)).client))
      unavailable(yield* search((yield* startClient(endpointAt(h.server.origin, "a-key-it-does-not-know"))).client))

      h.server.control.answer = () => new Response("404 page not found", { status: 404 })
      unavailable(yield* search(h.client))
      // A plain proxy's 404 on an entry is no memory either, not a missing entry.
      unavailable(yield* h.client.read(project, "k3f9x2m7q4tz").pipe(Effect.flip))

      h.server.control.answer = () =>
        Response.json(
          { error: { type: "busy", message: "no free turn" } },
          { status: 503, headers: { "retry-after": "1" } },
        )
      unavailable(yield* search(h.client))

      h.server.control.answer = undefined
      yield* Effect.promise(() => h.server.proxy.stop(true))
      unavailable(yield* search(h.client))
    }),
  )

  it.effect("is unavailable when start gets no answer within its timeout", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const release = h.server.hold()
      const fiber = yield* h.client
        .start(project, { prompt: "q", scopes: "all", limit: 5, by }, { timeout: "2 seconds" })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* until("the start request arrived", () => h.server.calls().length === 1)
      yield* TestClock.adjust("2 seconds")
      const error = yield* Fiber.join(fiber)
      release()
      expect(error).toBeInstanceOf(MemoryClient.Unavailable)
      expect(error._tag === "MemoryClient.Unavailable" && error.reason).toBe(
        "CLIProxyPacer is unreachable: no answer within 2s",
      )
    }),
  )
})

describe("MemoryClient.project", () => {
  const set = (name: string) => [
    new Document({ type: "document", info: new Info({ memory: new ConfigMemory.Info({ project: name }) }) }),
  ]
  const id = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

  it.effect("is memory.project when config sets it, else the chat's project, and none outside a project", () =>
    Effect.sync(() => {
      expect(MemoryClient.project([], id)).toBe(id)
      expect(MemoryClient.project(set("openforge-workspace"), id)).toBe("openforge-workspace")
      expect(MemoryClient.project(set("openforge-workspace"), Project.ID.global)).toBe("openforge-workspace")
      expect(MemoryClient.project([], Project.ID.global)).toBeUndefined()
      // The later document wins, as for every setting.
      expect(MemoryClient.project([...set("first"), ...set("second")], id)).toBe("second")
    }),
  )
})
