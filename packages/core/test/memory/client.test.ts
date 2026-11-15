import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { MemoryClient } from "@opencode/core/memory/client"
import { Project } from "@opencode/core/project"
import { Document, Info } from "@opencode/schema/config"
import { ConfigMemory } from "@opencode/schema/config/memory"
import { testEffect } from "../lib/effect"
import { until } from "../pacer/fake-tools"
import { endpointAt, key, memoryServer, startClient } from "./fixture"

// What a harness asks of memory (workspace reference `docs/reference/cpp-tools-api.md`, "A harness's texts"), against
// the small memory server and its harness side: who asks is in the headers, never in a body.

const it = testEffect(Layer.empty)
const project = "client-project"
const tools = { recall: true, remember: true, task: true }
/** A chat's headers as `PacerHeaders.chat` names it with its agent. */
const chat = (session = crypto.randomUUID()) => ({
  "X-Pacer-Session": session,
  "X-Pacer-Agent": "build",
  "X-Pacer-Chat": `ses_${session.slice(0, 8)}`,
})
/** A closed answer by its fields, as `toEqual` compares errors by their message alone. */
const closedOf = (error: MemoryClient.Error) =>
  error._tag === "MemoryClient.Closed" ? { type: error.type, project: error.project, moved: error.moved } : error
/** Writes an entry through the memory API, as a 0.0.42 chat would have. */
const write = (url: string, where: string, text: string, role = "build") =>
  Effect.promise(() =>
    fetch(`${url}/pacer/v1/memory/${where}/entries`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "verified", text, basis: "b", scope: "role", by: { role, chat: "ses_w" } }),
    }).then((answer) => answer.json() as Promise<{ entry: { id: string } }>),
  )
const make = (url: string, where: string, title: string, subtasks?: ReadonlyArray<{ title: string }>) =>
  Effect.promise(() =>
    fetch(`${url}/pacer/v1/memory/${where}/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ title, ...(subtasks ? { subtasks } : {}), by: { role: "build", chat: "ses_maker" } }),
    }).then((answer) => answer.json() as Promise<{ task: { id: string }; subtasks?: ReadonlyArray<{ id: string }> }>),
  )

const setup = Effect.gen(function* () {
  const server = yield* memoryServer
  const started = yield* startClient(endpointAt(server.origin))
  return { server, client: started.client }
})

describe("MemoryClient", () => {
  it.live("starts with the tools the chat may use, and answers CPP's block, its search and the place", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const written = yield* write(h.server.store.url, project, "The workspace repository has no git remote.")
      const headers = chat()
      const started = yield* h.client
        .withHeaders(headers)
        .start(project, { prompt: "does the repository have a git remote?", limit: 5, tools })
      expect(started.entries).toEqual([written.entry.id])
      expect(started.text).toContain(written.entry.id)
      expect(started.text).toContain("tools: recall true, remember true, task true")
      expect(started.recall).toEqual(expect.any(String))
      expect(started.shown).toEqual([])
      expect(started.place).toBeNull()
      const [call] = h.server.calls()
      // Who asks is the headers': no `by`, `scopes`, `task` or `subtask` in the body.
      expect(call?.body).toEqual({ prompt: "does the repository have a git remote?", limit: 5, tools })
      expect(call?.pacer).toMatchObject({ "x-pacer-agent": "build", "x-pacer-chat": headers["X-Pacer-Chat"] })
    }),
  )

  it.live("asks a prompt's entries and answers their message, or none", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const prompted = yield* h.client.withHeaders(chat()).prompt(project, { prompt: "anything", exclude: [] })
      // The small server without an embedding endpoint finds nothing close.
      expect(prompted).toEqual({ recall: expect.any(String), entries: [], text: null })
      expect(h.server.calls()[0]?.body).toEqual({ prompt: "anything", exclude: [] })
    }),
  )

  it.live("reads the chat's place and check, assigns, starts and ends a subagent's task", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const made = yield* make(h.server.store.url, project, "Move the checks", [{ title: "One" }, { title: "Two" }])
      const step = made.subtasks![1]!.id
      const lead = chat()
      expect(yield* h.client.withHeaders(lead).chat(project)).toEqual({ place: null, check: null })
      expect(yield* h.client.withHeaders(lead).assign(project, step)).toEqual({
        text: "",
        place: { task: made.task.id, subtask: step },
      })
      const missing = yield* h.client.withHeaders(lead).assign(project, "k3f9x2m7q4tz")
      expect(missing.error?.code).toBe("not_found")
      expect(missing.text).not.toBe("")

      const child = { ...chat(), "X-Pacer-Parent-Session": lead["X-Pacer-Session"] }
      expect((yield* h.client.withHeaders(child).begin(project, step)).place).toEqual({
        task: made.task.id,
        subtask: step,
      })
      expect(yield* h.client.withHeaders(child).chat(project)).toEqual({
        place: { task: made.task.id, subtask: step },
        check: expect.stringContaining(step),
      })
      expect(yield* h.client.withHeaders(lead).ended(project, step)).toBeNull()
      yield* Effect.promise(() =>
        fetch(`${h.server.store.url}/pacer/v1/memory/${project}/tasks/${step}/state`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ state: "review", by: { role: "build", chat: "ses_w" } }),
        }),
      )
      expect(yield* h.client.withHeaders(lead).ended(project, step)).toEqual(expect.stringContaining("review"))
    }),
  )

  it.live("reads memory's texts, without a project", () =>
    Effect.gen(function* () {
      const h = yield* setup
      expect(yield* h.client.texts()).toEqual({ unavailable: expect.any(String), refused: expect.any(String) })
      expect(h.server.received.at(-1)?.path).toBe("/pacer/v1/memory/texts")
    }),
  )

  it.live("is unavailable when not set up, unreachable, refused, a plain proxy, an older server, or busy", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const start = (client: MemoryClient.Interface) =>
        client.start(project, { prompt: "q", limit: 5, tools }).pipe(Effect.flip)
      const unavailable = (error: MemoryClient.Error) => expect(error).toBeInstanceOf(MemoryClient.Unavailable)

      unavailable(yield* start((yield* startClient(undefined)).client))
      unavailable(yield* start((yield* startClient(endpointAt(h.server.origin, "a-key-it-does-not-know"))).client))

      h.server.control.answer = () => new Response("404 page not found", { status: 404 })
      unavailable(yield* start(h.client))
      // A server before this release answers a start without the block's text.
      h.server.control.answer = () =>
        Response.json({ recall: null, entries: [], counts: { global: 0, role: 0, task: 0 } })
      unavailable(yield* start(h.client))
      h.server.control.answer = () =>
        Response.json(
          { error: { type: "busy", message: "no free turn" } },
          { status: 503, headers: { "retry-after": "1" } },
        )
      unavailable(yield* start(h.client))

      h.server.control.answer = undefined
      yield* Effect.promise(() => h.server.proxy.stop(true))
      unavailable(yield* start(h.client))
    }),
  )

  it.live("is closed when CPP says the project's memory is off or the key may not use it, on every route", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const off = `client-off-${crypto.randomUUID().slice(0, 8)}`
      const forbidden = `client-forbidden-${crypto.randomUUID().slice(0, 8)}`
      h.server.store.project(off, { memory: false })
      h.server.store.project(forbidden, { memory: true, keys: ["another-key"] })
      const named = h.client.withHeaders(chat())
      const every = (where: string) =>
        (
          [
            named.start(where, { prompt: "q", limit: 5, tools }),
            named.prompt(where, { prompt: "q", exclude: [] }),
            named.chat(where),
            named.assign(where, "k3f9x2m7q4tz"),
            named.begin(where, "k3f9x2m7q4tz"),
            named.ended(where, "k3f9x2m7q4tz"),
            named.after(where, "k3f9x2m7q4tz", { person: "p", by: { role: "build", chat: "ses_c" } }),
            named.recall(where, "k3f9x2m7q4tz"),
          ] as ReadonlyArray<Effect.Effect<unknown, MemoryClient.Error>>
        ).map((call) => call.pipe(Effect.flip))
      for (const [where, type] of [
        [off, "project_memory_off"],
        [forbidden, "project_forbidden"],
      ] as const)
        for (const error of yield* Effect.all(every(where)))
          expect(closedOf(error)).toEqual({ type, project: where, moved: false })
      expect(new MemoryClient.Closed({ type: "project_memory_off", project: "acme-web", moved: true }).message).toBe(
        'Memory is off for "acme-web", the project this chat was moved to',
      )
    }),
  )

  it.live("sends the headers it is given on every route, and none without them", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const headers = { "X-Pacer-Project": project, "X-Pacer-Project-Name": "openforge" }
      const named = h.client.withHeaders(headers)
      yield* Effect.all(
        [
          named.start(project, { prompt: "q", limit: 5, tools }, { timeout: "2 seconds" }),
          named.prompt(project, { prompt: "q", exclude: [] }),
          named.chat(project),
          named.assign(project, "k3f9x2m7q4tz"),
          named.begin(project, "k3f9x2m7q4tz"),
          named.ended(project, "k3f9x2m7q4tz"),
          named.after(project, "k3f9x2m7q4tz", { person: "p", by: { role: "build", chat: "ses_c" } }),
          named.recall(project, "k3f9x2m7q4tz"),
        ].map((call) => Effect.ignore(call)),
      )
      const calls = h.server.calls()
      expect(calls).toHaveLength(8)
      for (const call of calls)
        expect(call.pacer).toEqual({ "x-pacer-project": project, "x-pacer-project-name": "openforge" })
      yield* Effect.ignore(h.client.chat(project))
      expect(h.server.calls().at(-1)?.pacer).toEqual({})
    }),
  )

  it.effect("is unavailable when start gets no answer within its timeout", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const release = h.server.hold()
      const fiber = yield* h.client
        .start(project, { prompt: "q", limit: 5, tools }, { timeout: "2 seconds" })
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
