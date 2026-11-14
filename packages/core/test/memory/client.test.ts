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

  it.live("makes, lists, reads and changes tasks, and start answers the chat's task and subtask", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const made = yield* h.client.make(project, { title: "Move the checks", description: "One script.", by })
      expect(made.existing).toBe(false)
      expect(made.task).toMatchObject({
        title: "Move the checks",
        state: "todo",
        parent: null,
        by: { person: "floris" },
      })
      const sub = (yield* h.client.make(project, { title: "The first part", parent: made.task.id, by })).task
      expect((yield* h.client.make(project, { title: "Move the checks", by })).existing).toBe(true)
      const active = yield* h.client.change(project, sub.id, {
        state: "active",
        by: { role: "general", chat: "ses_w" },
      })
      expect(active.worker).toEqual({ person: "floris", role: "general", chat: "ses_w" })
      const entry = yield* h.client.write(project, {
        kind: "unverified",
        text: "The part starts in scripts/.",
        basis: "read the tree",
        scope: "task",
        by: { ...by, task: made.task.id, subtask: sub.id },
      })
      expect(entry.entry).toMatchObject({ scope: "task", task: made.task.id, subtask: sub.id })
      expect((yield* h.client.tasks(project)).tasks.map((task) => task.id)).toEqual([sub.id, made.task.id])
      const read = yield* h.client.task(project, made.task.id)
      expect(read.subtasks.map((task) => task.id)).toEqual([sub.id])
      expect(read.entries.map((item) => item.id)).toEqual([entry.entry.id])
      const started = yield* h.client.start(project, {
        prompt: "the checks",
        scopes: { global: true, roles: ["build"], tasks: [made.task.id] },
        limit: 5,
        task: made.task.id,
        subtask: sub.id,
        by,
      })
      // The task and the subtask as reading them answers.
      expect(started.task).toEqual(read)
      expect(started.subtask).toEqual(yield* h.client.task(project, sub.id))
      expect(started.counts.task).toBe(1)

      // An older server answers the task without changes and the subtask as a task alone: no changes, nothing noted.
      yield* h.client.change(project, sub.id, { state: "review", note: "half done", by })
      h.server.control.answer = async (request) => {
        const answer = await fetch(`${h.server.store.url}${request.path}`, {
          method: request.method,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(request.body),
        })
        const body = (await answer.json()) as {
          task: { task: unknown; subtasks: unknown; entries: unknown } | null
          subtask: { task: unknown } | null
        }
        return Response.json(
          {
            ...body,
            task: body.task && { task: body.task.task, subtasks: body.task.subtasks, entries: body.task.entries },
            subtask: body.subtask && body.subtask.task,
          },
          { status: answer.status },
        )
      }
      const older = yield* h.client.start(project, {
        prompt: "the checks",
        scopes: { global: true, roles: ["build"], tasks: [made.task.id] },
        limit: 5,
        task: made.task.id,
        subtask: sub.id,
        by,
      })
      h.server.control.answer = undefined
      const subRead = yield* h.client.task(project, sub.id)
      expect(subRead.changes[0]).toMatchObject({ state: "review", note: "half done" })
      expect(older.task).toEqual({ ...(yield* h.client.task(project, made.task.id)), changes: [] })
      expect(older.subtask).toEqual({ task: subRead.task, changes: [], subtasks: [], entries: [] })
      const missing = yield* h.client.task(project, "000000000000").pipe(Effect.flip)
      expect(missing.message).toBe("There is no task 000000000000 in this project's memory.")
      expect((yield* h.client.change("other-project", sub.id, { state: "done", by }).pipe(Effect.flip))._tag).toBe(
        "MemoryClient.MissingTask",
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

  it.live("is closed when CPP says the project's memory is off or the key may not use it, on every route", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const off = `client-off-${crypto.randomUUID().slice(0, 8)}`
      const forbidden = `client-forbidden-${crypto.randomUUID().slice(0, 8)}`
      h.server.store.project(off, { memory: false })
      h.server.store.project(forbidden, { memory: true, keys: ["another-key"] })
      const every = (where: string) =>
        (
          [
            h.client.write(where, { kind: "verified", text: "t", basis: "b", scope: "role", by }),
            h.client.read(where, "k3f9x2m7q4tz"),
            h.client.forget(where, "k3f9x2m7q4tz", { reason: "r", by }),
            h.client.search(where, { query: "q", scopes: "all", limit: 5, by }),
            h.client.start(where, { prompt: "q", scopes: "all", limit: 5, by }),
            h.client.make(where, { title: "t", by }),
            h.client.tasks(where),
            h.client.task(where, "k3f9x2m7q4tz"),
            h.client.change(where, "k3f9x2m7q4tz", { state: "done", by }),
            h.client.after(where, "k3f9x2m7q4tz", { person: "p", by }),
            h.client.recall(where, "k3f9x2m7q4tz"),
          ] as ReadonlyArray<Effect.Effect<unknown, MemoryClient.Error>>
        ).map((call) => call.pipe(Effect.flip))
      for (const [where, type] of [
        [off, "project_memory_off"],
        [forbidden, "project_forbidden"],
      ] as const)
        for (const error of yield* Effect.all(every(where))) expect(error).toEqual(new MemoryClient.Closed({ type }))
      expect(new MemoryClient.Closed({ type: "project_memory_off" }).message).toBe(
        "Memory is off for this project on CLIProxyPacer, so the work goes on without it.",
      )

      // Memory off for the whole server (CPP's `not_found` on a route naming no entry) stays unavailable.
      h.server.control.answer = () =>
        Response.json({ error: { type: "not_found", message: "memory is off" } }, { status: 404 })
      expect(
        yield* h.client.start(project, { prompt: "q", scopes: "all", limit: 5, by }).pipe(Effect.flip),
      ).toBeInstanceOf(MemoryClient.Unavailable)
      // So does a refused key with no project type.
      h.server.control.answer = () => Response.json({ error: { type: "forbidden", message: "no" } }, { status: 403 })
      expect(
        yield* h.client.start(project, { prompt: "q", scopes: "all", limit: 5, by }).pipe(Effect.flip),
      ).toBeInstanceOf(MemoryClient.Unavailable)
    }),
  )

  it.live("sends the headers it is given on every route, and none without them", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const named = h.client.withHeaders({ "X-Pacer-Project": project, "X-Pacer-Project-Name": "openforge" })
      yield* Effect.all(
        [
          named.write(project, { kind: "verified", text: "Named.", basis: "b", scope: "role", by }),
          named.read(project, "k3f9x2m7q4tz"),
          named.forget(project, "k3f9x2m7q4tz", { reason: "r", by }),
          named.search(project, { query: "q", scopes: "all", limit: 5, by }),
          named.start(project, { prompt: "q", scopes: "all", limit: 5, by }, { timeout: "2 seconds" }),
          named.make(project, { title: "Named", by }),
          named.tasks(project),
          named.task(project, "k3f9x2m7q4tz"),
          named.change(project, "k3f9x2m7q4tz", { state: "done", by }),
          named.after(project, "k3f9x2m7q4tz", { person: "p", by }),
          named.recall(project, "k3f9x2m7q4tz"),
        ].map((call) => Effect.ignore(call)),
      )
      const calls = h.server.calls()
      expect(calls).toHaveLength(11)
      for (const call of calls)
        expect(call.pacer).toEqual({ "x-pacer-project": project, "x-pacer-project-name": "openforge" })
      yield* Effect.ignore(h.client.tasks(project))
      expect(h.server.calls().at(-1)?.pacer).toEqual({})
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
