import { afterAll, beforeEach, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import path from "path"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { SessionContinuity } from "@opencode/core/continuity"
import { Database } from "@opencode/core/database/database"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { MemoryClient } from "@opencode/core/memory/client"
import { MemoryHeld } from "@opencode/core/memory/held"
import { MemoryHeldTable } from "@opencode/core/memory/held.sql"
import { MemoryTask } from "@opencode/core/memory/task"
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerNews } from "@opencode/core/pacer/news"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { SubagentEnded } from "@opencode/core/session/subagent-ended"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Tool } from "@opencode/core/tool"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { catalogOf, endpointAt } from "./memory/fixture"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

// A lead's message to its helper held until the lead answers the helper's handed-in round (the workspace's task
// khtzd8a7qje3, `MemoryHeld`). What is owed is CLIProxyPacer's to say; here a stand-in answers `GET …/owed` as the
// test sets it, the task tool is a stand-in whose marks change what is owed, and the hold, its release and its words are
// openforge's own, run through the real subagent tool, sessions, inbox and database.

const PROJECT = "held-test"
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

/** CLIProxyPacer as far as the hold reads it: what each helper's lead owes, by the helper's id. */
const cpp = {
  owed: new Map<string, ReadonlyArray<MemoryClient.Owed>>(),
  requests: [] as Array<{ readonly path: string; readonly search: string; readonly pacer: Record<string, string> }>,
  /** Whether the server says `review_owed`. */
  offers: true,
  /** Whether the read fails. */
  down: false,
  /** Whether a chat's tools hold the task tool. */
  task: true,
  /** What the task tool stand-in does with a call's arguments, before it answers. */
  onTask: (_input: Record<string, unknown>) => {},
}
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const url = new URL(request.url)
    cpp.requests.push({
      path: url.pathname,
      search: url.search,
      pacer: Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-pacer-"))),
    })
    if (url.pathname !== `/pacer/v1/memory/${PROJECT}/owed`)
      return Response.json({ error: { type: "not_found", message: "no route" } }, { status: 404 })
    if (cpp.down) return Response.json({ error: { type: "server_error", message: "down" } }, { status: 500 })
    return Response.json({ owed: cpp.owed.get(url.searchParams.get("helper") ?? "") ?? [] })
  },
})
afterAll(() => server.stop(true))
beforeEach(() => {
  cpp.owed.clear()
  cpp.requests.length = 0
  cpp.offers = true
  cpp.down = false
  cpp.task = true
  cpp.onTask = () => {}
})
const owedReads = () => cpp.requests.filter((request) => request.path.endsWith("/owed"))

const round = (n: number[]): MemoryClient.Owed => ({
  task: "t1",
  title: "Draw the counter",
  round: 1,
  items: n.map((item) => ({
    n: item,
    kind: item === 2 ? "text" : "picture",
    name: item === 2 ? "spec.md" : `screen ${item}.png`,
  })),
})

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const complete = Effect.fn("HeldTest.complete")(function* (sessionID: Session.ID) {
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node],
})

/** The subagent tool, and CPP's task tool as a stand-in: its call does what `cpp.onTask` says and answers. */
const supervisor = makeLocationNode({
  name: "test/held-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const tools = yield* Tool.Service
      yield* registerToolPlugin(
        SubagentTool.Plugin,
        { session: { hook: (name, callback) => hooks.register("session", name, callback) } },
        (name, callback) => hooks.register("tool", name, callback),
      )
      yield* tools
        .transform((editor) =>
          editor.add({
            name: "task",
            description: "CPP's task tool",
            options: { codemode: false },
            input: Schema.Struct({ id: Schema.String, marks: Schema.optional(Schema.Unknown) }),
            execute: (input) =>
              Effect.sync(() => {
                cpp.onTask(input)
                return { content: `Task ${input.id}'s round 1: your answers.` }
              }),
          }),
        )
        .pipe(Effect.orDie)
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    Model.node,
    Permission.node,
    Session.node,
    Job.node,
    SubagentJob.node,
    MemoryTask.node,
    MemoryHeld.node,
    PacerModels.node,
    SubagentEnded.node,
    Tool.node,
    PluginHooks.node,
    SessionContinuity.node,
  ],
})

const endpoint = Layer.succeed(
  PacerEndpoint.Service,
  PacerEndpoint.Service.of({ get: () => Effect.succeed(endpointAt(server.url.origin)), changes: () => Stream.empty }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      Session.node,
      SessionExecution.node,
      LocationServiceMap.node,
      SessionStore.node,
    ]),
    [
      SessionExecution.node.replace(executionNode),
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      PluginSupervisor.node.replace(supervisor),
      MemoryClient.node.replace(
        MemoryClient.layer.pipe(
          Layer.provide(PacerHttp.layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpoint))),
        ),
      ),
      PacerModels.node.replace(
        Layer.succeed(
          PacerModels.Service,
          PacerModels.Service.of({
            get: () => Effect.sync(() => catalogOf(true, { reviewOwed: cpp.offers })),
            changes: () => Stream.empty,
            refresh: () => Effect.void,
          }),
        ),
      ),
      PacerProject.node.replace(
        Layer.succeed(
          PacerProject.Service,
          PacerProject.Service.of({
            chat: () => Effect.succeed({ project: PROJECT, headers: { "X-Pacer-Project": PROJECT }, repository: "/project" }),
            session: () => Effect.succeed({ project: PROJECT, headers: { "X-Pacer-Project": PROJECT }, repository: "/project" }),
            headers: () => ({ "X-Pacer-Project": PROJECT }),
          }),
        ),
      ),
      PacerTools.node.replace(
        Layer.mock(PacerTools.Service, {
          holds: (_sessionID, name) => name === "task" && cpp.task,
          seen: () => {},
          cold: () => {},
          held: () => undefined,
        }),
      ),
    ],
  ),
)

/** A lead with one helper started in the background, and its calls. */
const prepare = Effect.fnUntraced(function* (dir: { readonly path: string }) {
  const sessions = yield* Session.Service
  const lead = yield* sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
    model: parentModel,
  })
  const locations = yield* LocationServiceMap.Service
  const services = locations.get(lead.location)
  yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(services))
  yield* Agent.Service.use((agents) =>
    agents.transform((editor) => {
      editor.update(toolIdentity.agent, (agent) => {
        agent.mode = "primary"
        agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
      })
      editor.update(Agent.ID.make("reviewer"), (agent) => {
        agent.mode = "subagent"
        agent.model = childModel
      })
    }),
  ).pipe(Effect.provide(services))
  const registry = yield* Tool.Service.pipe(Effect.provide(services))
  let calls = 0
  const call = (name: string, input: Record<string, unknown>, sessionID = lead.id) =>
    executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: `call-held-${++calls}`, name, input },
    })
  const started = yield* call(SubagentTool.name, {
    background: true,
    agent: "reviewer",
    description: "draw",
    prompt: "Draw the counter.",
  })
  const helper = outputSessionID(started.metadata)
  const follow = (prompt: string, description = "follow up") =>
    call(SubagentTool.name, { agent: "reviewer", description, prompt, sessionID: helper })
  const task = (input: Record<string, unknown>) => call("task", { id: "t1", ...input })
  /** The helper's messages as its inbox holds them. */
  const inbox = sessions
    .inbox(helper)
    .pipe(Effect.map((items) => items.flatMap((item) => (item.type === "user" ? [item.payload.text] : []))))
  const rows = Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db
      .select()
      .from(MemoryHeldTable)
      .where(eq(MemoryHeldTable.lead_id, lead.id))
      .all()
      .pipe(Effect.orDie)
  })
  return { sessions, lead, helper, call, follow, task, inbox, rows, services }
})
const withLead = <A, E, R>(body: (h: Effect.Success<ReturnType<typeof prepare>>) => Effect.Effect<A, E, R>) =>
  tmpdirScoped().pipe(Effect.flatMap(prepare), Effect.flatMap(body))

const heldText = (items: string) =>
  `Held, not sent: this helper handed in work for review that neither you nor the person has answered (task t1 "Draw the counter", round 1: ${items}).\nAnswer each item with the task tool's marks first: pass, deny or dismiss, and a note with words on what you deny. This message goes to the helper right after that call; a newer message to it replaces this one.`
const sentText = (helper: string, description = "follow up") =>
  `Your held message to subagent ${helper} ("${description}") is sent now, after this call. You will receive a <subagent> message when it goes idle.`

describe("a lead's message to its helper", () => {
  it.live(
    "is held while the helper's handed-in round is unanswered, and goes right after the marks that answer it",
    () =>
      withLead((h) =>
        Effect.gen(function* () {
          cpp.owed.set(h.helper, [round([1, 2])])
          const held = yield* h.follow("Make the colours match too.")
          expect(held).toEqual({
            status: "error",
            error: { type: "tool.execution", message: heldText("items 1 screen 1.png and 2 spec.md") },
          })
          expect(yield* h.inbox).toEqual(["You are a subagent spawned by another session.\nDraw the counter."])
          // Asked as the lead, with its own id, for the helper by its own id.
          const read = owedReads().at(-1)!
          expect(read.search).toBe(`?helper=${h.helper}`)
          expect(read.pacer["x-pacer-session"]).toBe(PacerSessionID.make(h.lead.id))
          expect(read.pacer["x-pacer-chat"]).toBe(h.lead.id)
          expect(read.pacer["x-pacer-parent-session"]).toBeUndefined()
          expect((yield* h.rows).map((row) => [row.helper_id, row.input])).toEqual([
            [h.helper, { agent: "reviewer", description: "follow up", prompt: "Make the colours match too." }],
          ])

          // Marks that leave the text unanswered release nothing.
          cpp.onTask = () => cpp.owed.set(h.helper, [round([2])])
          expect((yield* h.task({ marks: [{ item: 1, answer: "pass" }] })).content).toEqual([
            { type: "text", text: "Task t1's round 1: your answers." },
          ])
          expect(yield* h.inbox).toHaveLength(1)

          // The marks that answer the round: the message goes after the call, which says so.
          const seen: number[] = []
          cpp.onTask = () => {
            cpp.owed.set(h.helper, [])
            seen.push(owedReads().length)
          }
          const answered = yield* h.task({ marks: [{ item: 2, answer: "dismiss" }] })
          expect(answered.content).toEqual([
            { type: "text", text: `Task t1's round 1: your answers.\n\n${sentText(h.helper)}` },
          ])
          // Asked again only after the marks ran.
          expect(owedReads().length).toBe(seen[0]! + 1)
          expect(yield* h.inbox).toEqual([
            "You are a subagent spawned by another session.\nDraw the counter.",
            "Make the colours match too.",
          ])
          expect(yield* h.rows).toEqual([])
          // Nothing is held any more: the next task call sends nothing again.
          expect((yield* h.task({})).content).toEqual([{ type: "text", text: "Task t1's round 1: your answers." }])
          expect(yield* h.inbox).toHaveLength(2)
        }),
      ),
  )

  // Blocker news (the workspace's spec blocker-tasks.md, `PacerNews`) wake a lead with a queued message in its own chat,
  // never its helper's: what the woken lead then says to its helper is held the same.
  it.live("is held the same after blocker news woke the lead", () =>
    withLead((h) =>
      Effect.gen(function* () {
        cpp.owed.set(h.helper, [round([1, 2])])
        yield* PacerNews.admit(h.sessions, h.lead.id, {
          id: "news-1",
          kind: "through",
          task: "t2",
          blocked: "t3",
          summary: "Blocker t2 is through",
          text: "The board's news for this chat (CLIProxyPacer, not the person):\n- [t2] 'Fix it', which your [t3] 'Build it' waits for, is in review.",
        })
        expect((yield* h.sessions.inbox(h.lead.id)).map((item) => String(item.id))).toContain("msg_pacer_news_news-1")
        expect((yield* h.follow("The fix is in: make the colours match too.")).error?.message).toBe(
          heldText("items 1 screen 1.png and 2 spec.md"),
        )
        expect(yield* h.inbox).toEqual(["You are a subagent spawned by another session.\nDraw the counter."])
      }),
    ),
  )

  it.live("held again is replaced by the newer one, and one sent at once drops the held one", () =>
    withLead((h) =>
      Effect.gen(function* () {
        cpp.owed.set(h.helper, [round([1])])
        expect((yield* h.follow("First thought.")).status).toBe("error")
        expect((yield* h.follow("Second thought.", "second")).error?.message).toBe(heldText("item 1 screen 1.png"))
        expect((yield* h.rows).map((row) => row.input)).toEqual([
          { agent: "reviewer", description: "second", prompt: "Second thought." },
        ])
        cpp.onTask = () => cpp.owed.set(h.helper, [])
        expect((yield* h.task({ marks: [{ item: 1, answer: "pass" }] })).content).toEqual([
          { type: "text", text: `Task t1's round 1: your answers.\n\n${sentText(h.helper, "second")}` },
        ])
        expect((yield* h.inbox).slice(1)).toEqual(["Second thought."])

        // Held, then the person answers the round on the dashboard: the next message goes at once, the held one never.
        cpp.owed.set(h.helper, [round([1])])
        expect((yield* h.follow("Third thought.")).status).toBe("error")
        cpp.owed.set(h.helper, [])
        expect((yield* h.follow("Fourth thought.")).status).toBe("completed")
        expect(yield* h.rows).toEqual([])
        expect((yield* h.task({})).content).toEqual([{ type: "text", text: "Task t1's round 1: your answers." }])
        expect((yield* h.inbox).slice(1)).toEqual(["Second thought.", "Fourth thought."])
      }),
    ),
  )

  it.live("held is kept in the database, released by the next process under the id it was held with, once", () =>
    withLead((h) =>
      Effect.gen(function* () {
        // What a process that stopped left: a held message, and one it had admitted before it could drop its row.
        const database = yield* Database.Service
        const second = yield* h.call(SubagentTool.name, {
          background: true,
          agent: "reviewer",
          description: "second helper",
          prompt: "Write the spec.",
        })
        const other = outputSessionID(second.metadata)
        const kept = SessionMessage.ID.create()
        const admitted = SessionMessage.ID.create()
        for (const [helper, id, prompt, at] of [
          [h.helper, kept, "Kept across the stop.", 1],
          [other, admitted, "Admitted before the stop.", 2],
        ] as const)
          yield* database.db
            .insert(MemoryHeldTable)
            .values({
              helper_id: helper,
              lead_id: h.lead.id,
              message_id: id,
              input: { agent: "reviewer", description: "kept", prompt },
              time_created: at,
            })
            .run()
            .pipe(Effect.orDie)
        yield* h.sessions.prompt({ sessionID: other, id: admitted, text: "Admitted before the stop.", resume: false })

        const answer = yield* h.task({ marks: [{ item: 1, answer: "pass" }] })
        expect(answer.content).toEqual([
          {
            type: "text",
            text: `Task t1's round 1: your answers.\n\n${sentText(h.helper, "kept")}\n${sentText(other, "kept")}`,
          },
        ])
        expect((yield* h.sessions.inbox(h.helper)).map((item) => item.id)).toContain(kept)
        const admittedOnce = (yield* h.sessions.inbox(other)).filter((item) => item.id === admitted)
        expect(admittedOnce).toHaveLength(1)
        expect(yield* h.rows).toEqual([])
      }),
    ),
  )

  it.live("is sent as before while the server owes nothing, cannot say, or does not offer it", () =>
    withLead((h) =>
      Effect.gen(function* () {
        expect((yield* h.follow("Nothing owed.")).status).toBe("completed")
        cpp.down = true
        cpp.owed.set(h.helper, [round([1])])
        expect((yield* h.follow("Server down.")).status).toBe("completed")
        cpp.down = false
        cpp.offers = false
        const before = owedReads().length
        expect((yield* h.follow("Not offered.")).status).toBe("completed")
        expect(owedReads().length).toBe(before)
        expect((yield* h.inbox).slice(1)).toEqual(["Nothing owed.", "Server down.", "Not offered."])
        expect(yield* h.rows).toEqual([])
      }),
    ),
  )
})

describe("what a lead owes", () => {
  it.live("is never asked by a helper of its own helper, nor by a lead whose tools hold no task tool", () =>
    tmpdirScoped().pipe(
      Effect.tap((dir) =>
        Effect.promise(() =>
          Bun.write(path.join(dir.path, "opencode.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
        ),
      ),
      Effect.flatMap(prepare),
      Effect.flatMap((h) =>
        Effect.gen(function* () {
          // The helper runs a helper of its own, which hands in a round: a chat with a parent answers none.
          const nested = outputSessionID(
            (yield* h.call(
              SubagentTool.name,
              { background: true, agent: "reviewer", description: "badge", prompt: "Draw the badge." },
              h.helper,
            )).metadata,
          )
          cpp.owed.set(nested, [round([1])])
          const followed = yield* h.call(
            SubagentTool.name,
            { background: true, agent: "reviewer", description: "follow up", prompt: "Round it.", sessionID: nested },
            h.helper,
          )
          expect(followed.status).toBe("completed")
          expect(owedReads()).toEqual([])
          // A lead whose tools hold no task tool could never answer with marks.
          cpp.task = false
          cpp.owed.set(h.helper, [round([1])])
          expect((yield* h.follow("Make the colours match too.")).status).toBe("completed")
          expect(owedReads()).toEqual([])
          expect(yield* h.rows).toEqual([])
          // With it, the same follow-up is held.
          cpp.task = true
          expect((yield* h.follow("Make the colours match too.")).status).toBe("error")
          expect(owedReads()).toHaveLength(1)
        }),
      ),
    ),
  )
})

describe("the subagent tool's text", () => {
  it.live("says a lead's message may wait only while the server offers it, and only to a lead", () =>
    withLead((h) =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.Service.pipe(Effect.provide(h.services))
        const described = (sessionID: Session.ID) =>
          Effect.gen(function* () {
            const event = {
              sessionID,
              agent: toolIdentity.agent,
              model: parentModel,
              system: [],
              messages: [],
              tools: { [SubagentTool.name]: { description: SubagentTool.description, input: {} } },
              options: {},
            }
            yield* hooks.trigger("session", "context", event)
            return event.tools[SubagentTool.name]!.description
          })
        const listed = "\n\nAvailable subagents:\n"
        cpp.offers = false
        const without = yield* described(h.lead.id)
        expect(without.startsWith(`${SubagentTool.description}${listed}`)).toBe(true)
        cpp.offers = true
        const offered = yield* described(h.lead.id)
        expect(offered).toBe(without.replace(listed, `\n${SubagentTool.HELD}${listed}`))
        expect(yield* described(h.helper)).toBe(without)
      }),
    ),
  )
})
