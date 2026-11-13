import { afterAll, describe, expect } from "bun:test"
import { LLMEvent, LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { LanguageModel } from "@opencode/ai/effect"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { MemoryClient } from "@opencode/core/memory/client"
import { MemoryKnown } from "@opencode/core/memory/known"
import { MemoryStart } from "@opencode/core/memory/start"
import { MemoryText } from "@opencode/core/memory/text"
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { MemoryTools } from "@opencode/core/tool/plugin/memory"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Effect, Fiber, Layer, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { PacerHttp } from "@opencode/core/pacer/http"
import { testEffect } from "./lib/effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { permissionLayer } from "./lib/permission"
import { registerToolPlugin } from "./lib/tool"
import { settle, until } from "./pacer/fake-tools"
import { catalogOf, endpointAt, key, startProxied } from "./memory/fixture"

// The start block through the real runner: what each model request holds, over the small memory server. One server
// for the file; each test works in a project of its own.

const server = startProxied()
afterAll(() => server.stop())

/**
 * What the memory side sees, in the test's hands, as openforge's own services give it: each change is announced, as
 * a live service's catalog read is.
 */
const endpointRef = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpointAt(server.origin)))
const catalogRef = Effect.runSync(SubscriptionRef.make<PacerModels.Catalog | undefined>(catalogOf(true)))
const pacer = {
  get endpoint() {
    return Effect.runSync(SubscriptionRef.get(endpointRef))
  },
  set endpoint(next: PacerEndpoint.Endpoint | undefined) {
    if (!PacerEndpoint.same(next, this.endpoint)) Effect.runSync(SubscriptionRef.set(endpointRef, next))
  },
  get catalog() {
    return Effect.runSync(SubscriptionRef.get(catalogRef))
  },
  set catalog(next: PacerModels.Catalog | undefined) {
    Effect.runSync(SubscriptionRef.set(catalogRef, next))
  },
}

class LLMRequests extends Context.Service<LLMRequests, LLMRequest[]>()("test/MemoryStartRequests") {}
const testLLM = Layer.unwrap(
  Effect.sync(() => {
    const requests: LLMRequest[] = []
    return TestLLM.testLayer({
      fallback: [],
      transformRequest: (request) => {
        requests.push(request)
        return request
      },
    }).pipe(Layer.merge(Layer.succeed(LLMRequests, requests)))
  }),
)

const model = LanguageModel.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})
const none = { load: () => Effect.succeed(Instructions.empty) }
const endpoints = Layer.succeed(
  PacerEndpoint.Service,
  PacerEndpoint.Service.of({
    get: () => SubscriptionRef.get(endpointRef),
    changes: () => SubscriptionRef.changes(endpointRef),
  }),
)
const catalogs = Layer.succeed(
  PacerModels.Service,
  PacerModels.Service.of({
    get: () => SubscriptionRef.get(catalogRef),
    changes: () => SubscriptionRef.changes(catalogRef),
    refresh: () => Effect.void,
  }),
)
const client = Layer.fresh(MemoryClient.layer).pipe(
  Layer.provide(Layer.fresh(PacerHttp.layer).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpoints))),
)
const echo = makeLocationNode({
  name: "test/memory-start-tools",
  layer: Layer.effectDiscard(
    Tool.Service.use((registry) =>
      registry.transform((editor) => {
        editor.add({
          name: "echo",
          description: "Echo text",
          options: { codemode: false },
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
        })
      }),
    ),
  ),
  deps: [Tool.node],
})
// Memory's own tools, registered as in openforge. Their calls here read only the chat, which the store answers.
const memoryTools = makeLocationNode({
  name: "test/memory-start-memory-tools",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      yield* registerToolPlugin(MemoryTools.Plugin).pipe(
        Effect.provide(
          Layer.mock(Session.Service, {
            get: (sessionID) =>
              store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((found) =>
                    found ? Effect.succeed(found) : Effect.fail(new Session.NotFoundError({ sessionID })),
                  ),
                ),
            revert: {
              stage: () => Effect.die("unused"),
              clear: () => Effect.die("unused"),
              commit: () => Effect.die("unused"),
            },
          }),
        ),
      )
    }),
  ),
  deps: [
    Tool.node,
    Permission.node,
    PacerEndpoint.node,
    PacerModels.node,
    MemoryClient.node,
    SessionStore.node,
    Config.node,
    KV.node,
  ],
})
/** The test's database, counting its lookups (`select`). */
const lookups = { count: 0 }
const counting = Layer.effect(
  Database.Service,
  Effect.map(Database.Service, ({ db }) => ({
    db: new Proxy(db, {
      get: (target, key) => {
        if (key === "select") lookups.count++
        const value: unknown = target[key as keyof typeof target]
        return typeof value === "function" ? value.bind(target) : value
      },
    }),
  })),
).pipe(Layer.provide(Database.layer()), Layer.provide(Global.layerWith({})))
const replacements: LayerNode.Replacements = [
  Database.node.replace(counting),
  Snapshot.node.replace(Snapshot.noopLayer),
  LayerNodePlatform.llmClient.replace(testLLM),
  SessionRunnerModel.node.replace(models),
  InstructionBuiltIns.node.replace(Layer.mock(InstructionBuiltIns.Service, none)),
  InstructionDiscovery.node.replace(Layer.mock(InstructionDiscovery.Service, { project: true, global: true, ...none })),
  SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, none)),
  ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, none)),
  McpInstructions.node.replace(Layer.mock(McpInstructions.Service, none)),
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  Config.node.replace(Config.testLayer()),
  Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
  PluginSupervisor.node.replace(Layer.empty),
  Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
  PacerEndpoint.node.replace(endpoints),
  PacerModels.node.replace(catalogs),
  MemoryClient.node.replace(client),
]
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const runner = yield* SessionRunner.Service
    const drain = (sessionID: Session.ID, force: boolean): Effect.Effect<void, SessionRunner.RunError> =>
      runner.drain({ sessionID, force }).pipe(Effect.asVoid)
    const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({ drain })
    return SessionExecution.Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: (sessionID) => coordinator.interrupt(sessionID),
      awaitIdle: coordinator.awaitIdle,
    })
  }),
).pipe(Layer.provide(AppNodeBuilder.build(SessionRunnerLLM.node, replacements)), Layer.orDie)
const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    KV.node,
    Bus.node,
    SessionProjector.node,
    SessionStore.node,
    Agent.node,
    Model.node,
    PluginHooks.node,
    Tool.node,
    echo,
    memoryTools,
    Config.node,
    Snapshot.node,
    SessionRunnerLLM.node,
    Session.node,
  ]),
  [
    ...replacements,
    Bus.node.replace(Bus.configured({ persist: true })),
    LocationServiceMap.node.replace(promptLocationNode),
    Model.node.replace(
      Layer.mock(Model.Service, {
        get: () => Effect.undefined,
        all: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
        default: () => Effect.undefined,
        small: () => Effect.undefined,
      }),
    ),
    SessionExecution.node.replace(execution),
  ],
).pipe(Layer.provideMerge(testLLM))
const it = testEffect(layer)

const by = (role: string) => ({ role, chat: "ses_memory_preparing" })

/** A chat in a project of its own, a lead or a child of another, with what it runs and what the model got. */
const setup = Effect.fnUntraced(function* (
  input: {
    readonly agent?: string
    readonly child?: boolean
    /** The task the chat is inside: `inside` makes it from the chat's project before the chat is stored. */
    readonly inside?: (project: string) => Effect.Effect<{ task: string; subtask?: string }>
  } = {},
) {
  pacer.endpoint = endpointAt(server.origin)
  pacer.catalog = catalogOf(true)
  server.reset()
  server.control.answer = undefined
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
    editor.update(Agent.ID.make("explore"), (agent) => {
      agent.mode = "subagent"
    })
    // An agent whose permissions leave `recall` out, as a read-only agent of a person's own may.
    editor.update(Agent.ID.make("reader"), (agent) => {
      agent.mode = "subagent"
      agent.permissions = [{ action: "recall", resource: "*", effect: "deny" }]
    })
    // And one that may look but not save.
    editor.update(Agent.ID.make("viewer"), (agent) => {
      agent.mode = "subagent"
      agent.permissions = [{ action: "remember", resource: "*", effect: "deny" }]
    })
    // And one without the task tool.
    editor.update(Agent.ID.make("untasked"), (agent) => {
      agent.mode = "subagent"
      agent.permissions = [{ action: "task", resource: "*", effect: "deny" }]
    })
  })
  const project = Project.ID.make(crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"))
  yield* db
    .insert(ProjectTable)
    .values({ id: project, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const memory = yield* Effect.provide(MemoryClient.Service, client)
  const inside = input.inside ? yield* input.inside(project) : undefined
  const insert = (id: Session.ID, parent?: Session.ID, agent?: string) =>
    db
      .insert(SessionTable)
      .values({
        id,
        ...(parent ? { parent_id: parent } : {}),
        ...(inside ? { metadata: { memory: inside } } : {}),
        ...(agent ? { agent: Agent.ID.make(agent) } : {}),
        project_id: project,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  const lead = Session.ID.make(`ses_memory_${project.slice(0, 12)}`)
  yield* insert(lead)
  const sessionID = input.child ? Session.ID.make(`${lead}_child`) : lead
  if (input.child) yield* insert(sessionID, lead, input.agent)
  const session = yield* Session.Service
  const llm = yield* TestLLM.Test
  const requests = yield* LLMRequests
  const started = requests.length
  return {
    project,
    sessionID,
    session,
    llm,
    /** The model requests of this test. */
    requests: () => requests.slice(started),
    write: (input: Omit<MemoryClient.WriteInput, "by">, role = "build", where: string = project) =>
      memory.write(where, { ...input, by: by(role) }).pipe(
        Effect.map((written) => written.entry),
        Effect.orDie,
      ),
    prompt: (text: string) =>
      session.prompt({ sessionID, text, resume: false }).pipe(Effect.andThen(session.resume(sessionID))),
    /** The start blocks the chat holds, in order. */
    blocks: () =>
      session
        .messages({ sessionID, order: "asc" })
        .pipe(
          Effect.map((messages) =>
            messages.flatMap((message) =>
              message.type === "synthetic" && message.metadata?.memory !== undefined ? [message.text] : [],
            ),
          ),
        ),
    /** The ids of the start blocks the chat holds, in order. */
    blockIDs: () =>
      session
        .messages({ sessionID, order: "asc" })
        .pipe(
          Effect.map((messages) =>
            messages.flatMap((message) =>
              message.type === "synthetic" && message.metadata?.memory !== undefined ? [message.id] : [],
            ),
          ),
        ),
    /** Takes the chat back to before `messageID`, as the revert a person commits does. */
    revert: (messageID: SessionMessage.ID) =>
      session.revert
        .stage({ sessionID, messageID, files: false })
        .pipe(Effect.andThen(session.revert.commit(sessionID)), Effect.orDie),
    starts: () => server.calls().filter((call) => call.path === `/pacer/v1/memory/${project}/start`),
    /** What followed a search that was sent, for one row or all. */
    afters: (recall?: string) =>
      server
        .calls()
        .filter((call) =>
          recall
            ? call.path === `/pacer/v1/memory/${project}/recalls/${recall}/after`
            : call.path.startsWith(`/pacer/v1/memory/${project}/recalls/`) && call.path.endsWith("/after"),
        ),
    /** The searches of the chat's `recall` calls, in order, as the tool keeps them in its results' metadata. */
    searches: () =>
      session.messages({ sessionID, order: "asc" }).pipe(
        Effect.map((messages) =>
          messages.flatMap((message) =>
            message.type === "assistant"
              ? message.content.flatMap((part) =>
                  part.type === "tool" && part.name === "recall" && part.state.status === "completed"
                    ? [part.state.metadata as { project: string; recall: string; entries: string[] }]
                    : [],
                )
              : [],
          ),
        ),
      ),
    /** The search of the chat's newest start block. */
    blockRecall: () =>
      session.messages({ sessionID, order: "desc" }).pipe(
        Effect.map((messages) => {
          const block = messages.find((message) => message.type === "synthetic" && message.metadata?.memory)
          return String((block?.metadata?.memory as { recall?: string } | undefined)?.recall)
        }),
      ),
  }
})

const names = (request: LLMRequest | undefined) =>
  (request?.tools ?? []).map((tool) => tool.name).filter((name) => name !== "execute")
const blocksIn = (request: LLMRequest | undefined) => userTexts(request).filter((text) => text.startsWith("Memory"))

/** The texts of a request's user-role messages, in order: prompts and synthetic messages alike. */
const userTexts = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )
const day = (entry: MemoryClient.Entry) => new Date(entry.at).toISOString().slice(0, 10)
const opening =
  "Memory: what agents and people of this project noted earlier. It may be wrong or out of date; the code, the evidence and the person's words in this chat win over it."
const states =
  "If it cannot be done as written, set it blocked with what is wrong (the task tool) and stop. When the work is there, set it review."
const keep =
  "Keep it true as you work: replace an entry you find wrong, or an unverified one you have now checked (remember with supersedes), and remember only what a later chat could not get from the project's files, such as a trap you ran into or a rule the person gives; what you changed is in the files."

describe("MemoryStart through the runner", () => {
  it.live("puts the block after the first prompt, in the first request, with the default search's entries", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const global = yield* h.write({
        kind: "verified",
        text: "Zebra deploys run at noon.",
        basis: "cron",
        scope: "global",
      })
      const own = yield* h.write({ kind: "words", text: "Zebra deploys use the train.", scope: "role" })
      const otherRole = yield* h.write(
        { kind: "verified", text: "Zebra lint is strict.", basis: "ran", scope: "role" },
        "explore",
      )
      const otherProject = yield* h.write(
        { kind: "verified", text: "Zebra server is in Ghent.", basis: "dig", scope: "global" },
        "build",
        `${h.project}-other`,
      )
      yield* h.prompt("zebra deploys")

      const block = [
        opening,
        "What memory holds nearest to this prompt; it may not be about it:",
        // Equal scores: the nearer scope first.
        `- [${own.id}] Zebra deploys use the train. (words of floris, noted as build; role build; ${day(own)})`,
        `- [${global.id}] Zebra deploys run at noon. (verified by floris as build; global; ${day(global)}; basis: cron)`,
        `Memory holds 1 global entry and 1 of role build; recall finds them.`,
        keep,
      ].join("\n")
      expect(userTexts(h.requests()[0])).toEqual(["zebra deploys", block])
      expect(yield* h.blocks()).toEqual([block])
      for (const id of [otherRole.id, otherProject.id]) expect(block).not.toContain(id)
      expect(h.starts().map((call) => call.body)).toEqual([
        {
          prompt: "zebra deploys",
          scopes: { global: true, roles: ["build"] },
          limit: 5,
          by: { role: "build", chat: h.sessionID },
          task: null,
          subtask: null,
        },
      ])
    }),
  )

  it.live("holds at most 5 entries, leaves the middle out when there are none, and cuts the prompt to 2,000", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      for (const n of [1, 2, 3, 4, 5, 6, 7])
        yield* h.write({ kind: "unverified", text: `Quokka note ${n}.`, basis: "b", scope: "role" })
      yield* h.prompt("quokka ".repeat(400))
      const block = userTexts(h.requests()[0])[1] ?? ""
      expect(block.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(5)
      expect((h.starts()[0]?.body as { prompt: string }).prompt).toBe("quokka ".repeat(400).slice(0, 2_000))

      const empty = yield* setup()
      yield* empty.prompt("nothing is stored here")
      expect(userTexts(empty.requests()[0])[1]).toBe(
        [opening, "Memory holds 0 global entries and 0 of role build; recall finds them.", keep].join("\n"),
      )
    }),
  )

  it.live("is the same bytes through three steps, published once", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.write({ kind: "verified", text: "Echo twice before answering.", basis: "b", scope: "global" })
      yield* h.llm.push(
        TestLLM.toolCall("call-1", "echo", { text: "one" }),
        TestLLM.toolCall("call-2", "echo", { text: "two" }),
        TestLLM.text("done", "text-done"),
      )
      yield* h.prompt("echo twice")
      const requests = h.requests()
      expect(requests).toHaveLength(3)
      const blocks = requests.map((request) => userTexts(request).filter((text) => text.startsWith("Memory:")))
      expect(blocks[0]).toHaveLength(1)
      expect(blocks[1]).toEqual(blocks[0])
      expect(blocks[2]).toEqual(blocks[0])
      expect(yield* h.blocks()).toEqual(blocks[0])
      expect(h.starts()).toHaveLength(1)
    }),
  )

  it.live("is built again after a compaction, from the newest prompt", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const zebra = yield* h.write({
        kind: "verified",
        text: "Zebra deploys run at noon.",
        basis: "cron",
        scope: "global",
      })
      const quokka = yield* h.write({ kind: "verified", text: "Quokka lint is strict.", basis: "ran", scope: "global" })
      yield* h.prompt("zebra deploys?")
      yield* h.llm.push(TestLLM.text("## Objective\n- summary", "summary"))
      yield* h.session.compact({ sessionID: h.sessionID })
      yield* h.session.resume(h.sessionID)
      yield* h.prompt("quokka lint?")

      expect(h.starts().map((call) => (call.body as { prompt: string }).prompt)).toEqual([
        "zebra deploys?",
        "quokka lint?",
      ])
      const blocks = yield* h.blocks()
      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toContain(zebra.id)
      expect(blocks[1]).toContain(quokka.id)
      const last = userTexts(h.requests().at(-1))
      expect(last.filter((text) => text.startsWith("Memory:"))).toEqual([blocks[1]])
    }),
  )

  it.live("is built again after a revert took it out, from the newest prompt in the chat", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const zebra = yield* h.write({
        kind: "verified",
        text: "Zebra deploys run at noon.",
        basis: "cron",
        scope: "global",
      })
      const walrus = yield* h.write({ kind: "verified", text: "Walrus lint is strict.", basis: "ran", scope: "global" })
      yield* h.prompt("zebra deploys?")
      yield* h.prompt("and on fridays?")
      const [first] = yield* h.blockIDs()
      expect(first).toBeDefined()
      // Back to before the block: the first prompt stays, the block and all after it go.
      yield* h.revert(first!)
      expect(yield* h.blocks()).toEqual([])
      yield* h.prompt("walrus lint?")

      expect(h.starts().map((call) => (call.body as { prompt: string }).prompt)).toEqual([
        "zebra deploys?",
        "walrus lint?",
      ])
      const blocks = yield* h.blocks()
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toContain(walrus.id)
      expect(blocks[0]).not.toContain(zebra.id)
      const last = userTexts(h.requests().at(-1))
      expect(last).toEqual(["zebra deploys?", "walrus lint?", blocks[0]])
    }),
  )

  it.live("gives the one line when the server fails after a revert took the old block with it", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.write({ kind: "verified", text: "Zebra deploys run at noon.", basis: "cron", scope: "global" })
      yield* h.prompt("zebra deploys?")
      const [first] = yield* h.blockIDs()
      yield* h.revert(first!)
      server.control.answer = () => new Response("bad gateway", { status: 502 })
      yield* h.prompt("walrus lint?")
      expect(yield* h.blocks()).toEqual([MemoryText.unavailable])
      expect(userTexts(h.requests().at(-1)).at(-1)).toBe(MemoryText.unavailable)
    }),
  )

  it.live("gives a new chat the one line when the server fails, and a chat its old block after a compaction", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      server.control.answer = () =>
        Response.json({ error: { type: "unavailable", message: "store not open" } }, { status: 503 })
      yield* h.prompt("zebra?")
      expect(userTexts(h.requests()[0])).toEqual(["zebra?", MemoryText.unavailable])
      expect(MemoryText.unavailable).toBe("Memory is unavailable right now, so this chat starts without it.")

      const k = yield* setup()
      yield* k.write({ kind: "verified", text: "Zebra deploys run at noon.", basis: "cron", scope: "global" })
      yield* k.prompt("zebra?")
      const first = (yield* k.blocks())[0]
      yield* k.llm.push(TestLLM.text("## Objective\n- summary", "summary"))
      yield* k.session.compact({ sessionID: k.sessionID })
      yield* k.session.resume(k.sessionID)
      server.control.answer = () => new Response("bad gateway", { status: 502 })
      yield* k.prompt("quokka?")
      expect(yield* k.blocks()).toEqual([first, first])
      expect(userTexts(k.requests().at(-1)).filter((text) => text.startsWith("Memory:"))).toEqual([first])
    }),
  )

  it.effect("waits at most 2 seconds for the server, then the chat goes on with the one line", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      // Released however the test ends, so a failure here holds up no other test of the file's one server.
      yield* Effect.acquireRelease(Effect.sync(server.hold), (release) => Effect.sync(release))
      const run = yield* h.prompt("zebra?").pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the start request arrived", () => h.starts().length === 1)
      expect(h.requests()).toHaveLength(0)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)
      expect(userTexts(h.requests()[0])).toEqual(["zebra?", MemoryText.unavailable])
    }),
  )

  it.live("puts nothing at all in when the server has no memory, or no CLIProxyPacer is set up", () =>
    Effect.gen(function* () {
      for (const set of [
        () => (pacer.catalog = catalogOf(false)),
        () => (pacer.catalog = catalogOf("no pacer")),
        () => (pacer.endpoint = undefined),
      ]) {
        const h = yield* setup()
        set()
        yield* h.prompt("zebra?")
        expect(userTexts(h.requests()[0])).toEqual(["zebra?"])
        expect(yield* h.blocks()).toEqual([])
        expect(h.starts()).toEqual([])
      }
    }),
  )

  it.live("decides at the first step: an unread catalog goes as the server was last known, and nothing later", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const key = MemoryKnown.key(endpointAt(server.origin))
      for (const known of [true, false]) {
        const h = yield* setup()
        pacer.catalog = undefined
        yield* kv.set(key, known)
        yield* h.llm.push(TestLLM.toolCall("call-1", "echo", { text: "one" }), TestLLM.text("done", "text-done"))
        const gate = yield* h.llm.gate()
        const run = yield* h.prompt("zebra?").pipe(Effect.forkChild({ startImmediately: true }))
        yield* gate.started
        pacer.catalog = catalogOf(true)
        yield* gate.release
        yield* Fiber.join(run)
        // Whether the server has tasks is known only once its catalog is read: till the next compaction, none.
        const expected = known ? ["echo", "forget", "recall", "remember"] : ["echo"]
        for (const request of h.requests()) expect(names(request)).toEqual(expected)
        expect(h.requests().map((request) => blocksIn(request).length)).toEqual(known ? [1, 1] : [0, 0])
      }
      yield* kv.remove(key)
    }),
  )

  it.live("gives a child a block of its own, for its own role", () =>
    Effect.gen(function* () {
      const h = yield* setup({ child: true, agent: "explore" })
      const own = yield* h.write(
        { kind: "unverified", text: "Zebra files live in src.", basis: "ls", scope: "role" },
        "explore",
      )
      const lead = yield* h.write({ kind: "unverified", text: "Zebra builds are slow.", basis: "felt", scope: "role" })
      yield* h.prompt("where are the zebra files?")
      const block = userTexts(h.requests()[0])[1] ?? ""
      expect(block).toContain(own.id)
      expect(block).not.toContain(lead.id)
      expect(block).toEndWith(`Memory holds 0 global entries and 1 of role explore; recall finds them.\n${keep}`)
      expect(h.starts()[0]?.body).toMatchObject({
        scopes: { global: true, roles: ["explore"] },
        by: { role: "explore", chat: h.sessionID },
      })
    }),
  )

  it.live("names recall only in a chat that has the tool", () =>
    Effect.gen(function* () {
      const h = yield* setup({ child: true, agent: "reader" })
      const own = yield* h.write(
        { kind: "unverified", text: "Zebra files live in src.", basis: "ls", scope: "role" },
        "reader",
      )
      yield* h.prompt("where are the zebra files?")
      const request = h.requests()[0]
      expect(request?.tools.map((tool) => tool.name)).not.toContain("recall")
      expect(userTexts(request)[1]).toBe(
        [
          opening,
          "What memory holds nearest to this prompt; it may not be about it:",
          `- [${own.id}] Zebra files live in src. (unverified by floris as reader; role reader; ${day(own)}; basis: ls)`,
          "Memory holds 0 global entries and 1 of role reader.",
          keep,
        ].join("\n"),
      )
    }),
  )

  it.live("says that memory is the chat's to keep true only in a chat that can save", () =>
    Effect.gen(function* () {
      const h = yield* setup({ child: true, agent: "viewer" })
      const own = yield* h.write(
        { kind: "unverified", text: "Zebra files live in src.", basis: "ls", scope: "role" },
        "viewer",
      )
      yield* h.prompt("where are the zebra files?")
      const request = h.requests()[0]
      expect(request?.tools.map((tool) => tool.name)).toContain("recall")
      expect(request?.tools.map((tool) => tool.name)).not.toContain("remember")
      expect(userTexts(request)[1]).toBe(
        [
          opening,
          "What memory holds nearest to this prompt; it may not be about it:",
          `- [${own.id}] Zebra files live in src. (unverified by floris as viewer; role viewer; ${day(own)}; basis: ls)`,
          `Memory holds 0 global entries and 1 of role viewer; recall finds them.`,
        ].join("\n"),
      )
    }),
  )
})

describe("MemoryStart while the server's memory comes and goes", () => {
  const withTasks = (tasks: boolean) => {
    const catalog = catalogOf(true)
    return { ...catalog, pacer: { ...catalog.pacer!, memory: { ...catalog.pacer!.memory!, tasks } } }
  }
  const compact = (h: Effect.Success<ReturnType<typeof setup>>) =>
    Effect.gen(function* () {
      yield* h.llm.push(TestLLM.text("## Objective\n- summary", "summary"))
      yield* h.session.compact({ sessionID: h.sessionID })
      yield* h.session.resume(h.sessionID)
    })

  it.live("a step on a server without memory looks nothing of the chat up", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const info = yield* h.session.get(h.sessionID).pipe(Effect.orDie)
      const input = { session: info, agent: "build", recall: true, remember: true, task: true }
      yield* Effect.gen(function* () {
        const start = yield* MemoryStart.Service
        pacer.catalog = catalogOf(false)
        lookups.count = 0
        yield* start.ensure(input)
        // 0.0.31 looked up the chat's block and steps at every step boundary first: three lookups a step.
        expect(lookups.count).toBe(0)
        pacer.catalog = catalogOf(true)
        yield* start.ensure(input)
        expect(lookups.count).toBeGreaterThan(0)
      }).pipe(Effect.provide(AppNodeBuilder.build(MemoryStart.node, replacements)))
    }),
  )

  it.live("a running chat without memory keeps its tools and gets no block when memory comes, till a compaction", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      pacer.catalog = catalogOf(false)
      yield* h.llm.push(TestLLM.text("no zebras", "text-zebra"))
      yield* h.prompt("zebra?")
      const first = h.requests()[0]
      expect(names(first)).toEqual(["echo"])

      pacer.catalog = catalogOf(true)
      yield* h.llm.push(TestLLM.toolCall("call-1", "echo", { text: "one" }), TestLLM.text("done", "text-done"))
      yield* h.prompt("and on fridays?")
      for (const request of h.requests().slice(1)) {
        expect(JSON.stringify(request.tools)).toBe(JSON.stringify(first?.tools))
        expect(blocksIn(request)).toEqual([])
      }
      expect(yield* h.blocks()).toEqual([])
      expect(h.starts()).toEqual([])

      yield* compact(h)
      yield* h.prompt("quokka?")
      const after = h.requests().at(-1)
      expect(names(after)).toEqual(["echo", "forget", "recall", "remember", "task"])
      expect(blocksIn(after)).toHaveLength(1)
      expect(yield* h.blocks()).toHaveLength(1)
    }),
  )

  it.live("a chat with memory keeps its tools byte for byte when memory goes; a chat started then has neither", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("zebra?")
      const first = h.requests()[0]
      expect(names(first)).toEqual(["echo", "forget", "recall", "remember", "task"])
      const block = blocksIn(first)

      pacer.catalog = catalogOf(false)
      yield* h.llm.push(TestLLM.toolCall("call-recall", "recall", { query: "zebra" }), TestLLM.text("ok", "text-ok"))
      yield* h.prompt("and on fridays?")
      for (const request of h.requests().slice(1)) {
        expect(JSON.stringify(request.tools)).toBe(JSON.stringify(first?.tools))
        expect(blocksIn(request)).toEqual(block)
      }
      // The call answers that memory is unavailable, and nothing reaches the server.
      expect(JSON.stringify(h.requests().at(-1)?.messages)).toContain(
        "Memory is unavailable right now, so the work goes on without it.",
      )
      expect(server.calls().filter((call) => call.path.endsWith("/search"))).toEqual([])

      const k = yield* setup()
      pacer.catalog = catalogOf(false)
      yield* k.prompt("zebra?")
      expect(names(k.requests()[0])).toEqual(["echo"])
      expect(blocksIn(k.requests()[0])).toEqual([])
    }),
  )

  it.live("tasks coming or going change no running chat's tools; a new chat gets task as the server says", () =>
    Effect.gen(function* () {
      for (const [from, to] of [
        [false, true],
        [true, false],
      ]) {
        const h = yield* setup()
        pacer.catalog = withTasks(from)
        yield* h.prompt("zebra?")
        const first = h.requests()[0]
        expect(names(first).includes("task")).toBe(from)
        pacer.catalog = withTasks(to)
        yield* h.prompt("and on fridays?")
        expect(JSON.stringify(h.requests().at(-1)?.tools)).toBe(JSON.stringify(first?.tools))

        const k = yield* setup()
        pacer.catalog = withTasks(to)
        yield* k.prompt("zebra?")
        expect(names(k.requests()[0]).includes("task")).toBe(to)
      }
    }),
  )

  it.live("a step right after a restart, before the catalog is read, offers what the chat's block says", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("zebra?")
      const first = h.requests()[0]
      // A new process: nothing read yet, and nothing known of the server.
      pacer.catalog = undefined
      yield* h.prompt("and on fridays?")
      expect(JSON.stringify(h.requests().at(-1)?.tools)).toBe(JSON.stringify(first?.tools))
      expect(names(first)).toEqual(["echo", "forget", "recall", "remember", "task"])
    }),
  )

  it.live("a subagent decides at its own first step, whatever its lead has", () =>
    Effect.gen(function* () {
      const h = yield* setup({ child: true, agent: "explore" })
      pacer.catalog = catalogOf(false)
      yield* h.llm.push(TestLLM.text("in src", "text-src"))
      yield* h.prompt("where are the zebra files?")
      pacer.catalog = catalogOf(true)
      yield* h.prompt("and the quokka ones?")
      for (const request of h.requests()) expect(names(request)).toEqual(["echo"])
    }),
  )
})

describe("MemoryStart inside a task", () => {
  const memoryOf = Effect.provide(MemoryClient.Service, client)
  const make = (project: string, title: string, description?: string, parent?: string) =>
    memoryOf.pipe(
      Effect.flatMap((memory) =>
        memory.make(project, {
          title,
          ...(description === undefined ? {} : { description }),
          ...(parent ? { parent } : {}),
          by: by("build"),
        }),
      ),
      Effect.map((made) => made.task),
      Effect.orDie,
    )
  const ids: { task: string; subtask: string } = { task: "", subtask: "" }
  /** A change of the task's state, said by a child. */
  const set = (project: string, id: string, state: MemoryClient.State, note?: string) =>
    memoryOf.pipe(
      Effect.flatMap((memory) =>
        memory.change(project, id, {
          state,
          ...(note === undefined ? {} : { note }),
          by: { role: "general", chat: "ses_child" },
        }),
      ),
      Effect.map((changed) => new Date(changed.changed).toISOString().slice(0, 10)),
      Effect.orDie,
    )
  /** An entry noted in the task. */
  const note = (project: string, text: string) =>
    memoryOf.pipe(
      Effect.flatMap((memory) =>
        memory.write(project, {
          kind: "verified",
          text,
          basis: "b",
          scope: "task",
          by: { ...by("build"), task: ids.task },
        }),
      ),
      Effect.map((written) => written.entry),
      Effect.orDie,
    )

  it.live(
    "begins with the task and its description; what was said and noted in it and the nearest entries come under the opening",
    () =>
      Effect.gen(function* () {
        const h = yield* setup({
          inside: (project) =>
            make(project, "Move the checks", "One script.\nDone when it passes.").pipe(
              Effect.map((task) => {
                ids.task = task.id
                return { task: task.id }
              }),
            ),
        })
        const noted = yield* note(h.project, "The script is scripts/check.ts.")
        const found = yield* set(h.project, ids.task, "review", "Run bun run gen first, then bun test.")
        // A later change without a note: what was said with the first stays.
        yield* set(h.project, ids.task, "active")
        const global = yield* h.write({
          kind: "verified",
          text: "Zebra deploys run at noon.",
          basis: "cron",
          scope: "global",
        })
        yield* h.prompt("zebra deploys")
        expect(userTexts(h.requests()[0])[1]).toBe(
          [
            `Your task [${ids.task}]: Move the checks (active)`,
            "One script.",
            "Done when it passes.",
            states,
            opening,
            "Said with the task's changes of state, newest first:",
            `- ${found} review by floris as general: Run bun run gen first, then bun test.`,
            "What was noted in the task, newest first:",
            MemoryText.entry(noted),
            "What memory holds nearest to this prompt; it may not be about it:",
            MemoryText.entry(global),
            `Memory holds 1 global entry and 0 of role build, 1 of this task; recall finds them.`,
            keep,
          ].join("\n"),
        )
        expect(h.starts()[0]?.body).toMatchObject({
          scopes: { global: true, roles: ["build"], tasks: [ids.task] },
          task: ids.task,
          subtask: null,
          by: { role: "build", chat: h.sessionID, task: ids.task },
        })
      }),
  )

  it.live("with nothing noted in the task, the notes are left out with their heading", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        inside: (project) =>
          make(project, "Move the checks", "One script.").pipe(
            Effect.map((task) => {
              ids.task = task.id
              return { task: task.id }
            }),
          ),
      })
      const global = yield* h.write({
        kind: "verified",
        text: "Zebra deploys run at noon.",
        basis: "cron",
        scope: "global",
      })
      yield* h.prompt("zebra deploys")
      expect(userTexts(h.requests()[0])[1]).toBe(
        [
          `Your task [${ids.task}]: Move the checks (todo)`,
          "One script.",
          states,
          opening,
          "What memory holds nearest to this prompt; it may not be about it:",
          MemoryText.entry(global),
          `Memory holds 1 global entry and 0 of role build, 0 of this task; recall finds them.`,
          keep,
        ].join("\n"),
      )
    }),
  )

  it.live("inside a subtask begins with the subtask and the task it is part of", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        child: true,
        agent: "explore",
        inside: (project) =>
          make(project, "Move the checks", "One script.").pipe(
            Effect.flatMap((task) => make(project, "The first half", "Only the lint part.", task.id)),
            Effect.map((sub) => {
              ids.task = sub.parent!
              ids.subtask = sub.id
              return { task: sub.parent!, subtask: sub.id }
            }),
          ),
      })
      yield* h.prompt("go on")
      expect(userTexts(h.requests()[0])[1]).toBe(
        [
          `Your task [${ids.subtask}]: The first half (todo)`,
          `Part of task [${ids.task}]: Move the checks.`,
          "Only the lint part.",
          states,
          opening,
          "Memory holds 0 global entries and 0 of role explore, 0 of this task; recall finds them.",
          keep,
        ].join("\n"),
      )
      expect(h.starts()[0]?.body).toMatchObject({ task: ids.task, subtask: ids.subtask })
    }),
  )

  it.live("inside a subtask what was said with the subtask's changes comes before the task's", () =>
    Effect.gen(function* () {
      const said: string[] = []
      const h = yield* setup({
        child: true,
        agent: "explore",
        inside: (project) =>
          make(project, "Move the checks", "One script.").pipe(
            Effect.flatMap((task) => make(project, "The first half", "Only the lint part.", task.id)),
            Effect.tap((sub) =>
              Effect.gen(function* () {
                said.push(`- ${yield* set(project, sub.parent!, "blocked", "The old script is gone.")} blocked`)
                said.push(`- ${yield* set(project, sub.parent!, "active")}`)
                said.push(`- ${yield* set(project, sub.id, "review", "Lint runs from scripts/lint.ts.")} review`)
              }),
            ),
            Effect.map((sub) => {
              ids.task = sub.parent!
              ids.subtask = sub.id
              return { task: sub.parent!, subtask: sub.id }
            }),
          ),
      })
      yield* h.prompt("go on")
      expect(userTexts(h.requests()[0])[1]).toBe(
        [
          `Your task [${ids.subtask}]: The first half (review)`,
          `Part of task [${ids.task}]: Move the checks.`,
          "Only the lint part.",
          states,
          opening,
          "Said with the task's changes of state, newest first:",
          `${said[2]} by floris as general: Lint runs from scripts/lint.ts.`,
          `${said[0]} by floris as general: The old script is gone.`,
          "Memory holds 0 global entries and 0 of role explore, 0 of this task; recall finds them.",
          keep,
        ].join("\n"),
      )
    }),
  )

  it.live("inside a subtask without a description the line on the state follows the task it is part of", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        child: true,
        agent: "explore",
        inside: (project) =>
          make(project, "Move the checks").pipe(
            Effect.flatMap((task) => make(project, "The first half", undefined, task.id)),
            Effect.map((sub) => {
              ids.task = sub.parent!
              ids.subtask = sub.id
              return { task: sub.parent!, subtask: sub.id }
            }),
          ),
      })
      yield* h.prompt("go on")
      expect(userTexts(h.requests()[0])[1]).toBe(
        [
          `Your task [${ids.subtask}]: The first half (todo)`,
          `Part of task [${ids.task}]: Move the checks.`,
          states,
          opening,
          "Memory holds 0 global entries and 0 of role explore, 0 of this task; recall finds them.",
          keep,
        ].join("\n"),
      )
    }),
  )

  it.live("a chat without the task tool gets no line on the task's state", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        child: true,
        agent: "untasked",
        inside: (project) =>
          make(project, "Move the checks", "One script.").pipe(
            Effect.map((task) => {
              ids.task = task.id
              return { task: task.id }
            }),
          ),
      })
      yield* h.prompt("go on")
      const request = h.requests()[0]
      expect(request?.tools.map((tool) => tool.name)).not.toContain("task")
      expect(userTexts(request)[1]).toBe(
        [
          `Your task [${ids.task}]: Move the checks (todo)`,
          "One script.",
          opening,
          "Memory holds 0 global entries and 0 of role untasked, 0 of this task; recall finds them.",
          keep,
        ].join("\n"),
      )
    }),
  )

  it.live("keeps the task part within 4,000 characters: the oldest entries go first, then the description's end", () =>
    Effect.gen(function* () {
      const long = "d".repeat(1_000)
      const h = yield* setup({
        inside: (project) =>
          make(project, "Long task", long).pipe(
            Effect.map((task) => {
              ids.task = task.id
              return { task: task.id }
            }),
          ),
      })
      const written: MemoryClient.Entry[] = []
      for (const n of Array.from({ length: 12 }, (_, index) => index))
        written.push(yield* note(h.project, `Entry ${n} ${"e".repeat(300)}.`))
      yield* h.prompt("go on")
      const block = userTexts(h.requests()[0])[1] ?? ""
      // The assignment above the opening and the notes under it are bounded together.
      const assignment = block.slice(0, block.indexOf(`\n${opening}\n`))
      const notes = block.slice(block.indexOf(`${opening}\n`) + opening.length + 1, block.indexOf("\nMemory holds "))
      // The line on the task's state is kept and counts.
      expect(assignment).toBe(`Your task [${ids.task}]: Long task (todo)\n${long}\n${states}`)
      expect(notes).toStartWith("What was noted in the task, newest first:\n")
      const part = `${assignment}\n${notes}`
      expect([...part].length).toBeLessThanOrEqual(MemoryText.TASK_CHARACTERS)
      expect([...part].length).toBeGreaterThan(MemoryText.TASK_CHARACTERS - 400)
      // The newest entries are there, the oldest are not.
      const kept = written.filter((entry) => part.includes(entry.id))
      expect(kept.length).toBeGreaterThan(0)
      expect(kept.length).toBeLessThan(written.length)
      expect(kept).toEqual(written.slice(written.length - kept.length))
      expect(part).toContain(long)
    }),
  )
})

/** Waits, in real time, until `check` holds; at most 5 seconds. */
const eventually = (label: string, check: () => boolean) =>
  Effect.gen(function* () {
    const deadline = performance.now() + 5_000
    while (!check()) {
      if (performance.now() > deadline) return yield* Effect.die(new Error(`never happened: ${label}`))
      yield* Effect.sleep("5 millis")
    }
  })

/** A step that says `text` and makes the calls, in order. */
const step = (text: string, ...calls: ReadonlyArray<readonly [string, Record<string, unknown>]>) =>
  TestLLM.toolCalls(
    LLMEvent.textStart({ id: "said" }),
    LLMEvent.textDelta({ id: "said", text }),
    LLMEvent.textEnd({ id: "said" }),
    ...calls.map(([name, input], index) => LLMEvent.toolCall({ id: `call-${name}-${index}`, name, input })),
  )
const json = (value: unknown) => JSON.stringify(value)
// Built here rather than written out, so no secret scanner reads this file as holding one.
const fill = (length: number) => "Q7x".repeat(length).slice(0, length)

describe("MemoryFollowed through the runner", () => {
  it.live(
    "after the step that reads a recall's result, its text and calls go to the search's row, with the entries it replaced or deleted",
    () =>
      Effect.gen(function* () {
        const h = yield* setup()
        const [kept, replaced, deleted] = yield* Effect.forEach([1, 2, 3], (n) =>
          h
            .write({ kind: "verified", text: `Zebra fact ${n}.`, basis: "b", scope: "global" })
            .pipe(Effect.map((entry) => entry.id)),
        )
        const remember = { text: "Zebra fact two, corrected.", kind: "verified", basis: "b", supersedes: replaced }
        const forget = { id: deleted, reason: "wrong" }
        const elsewhere = { id: "000000000000", reason: "not one of them" }
        yield* h.llm.push(
          step("Let me look.", ["recall", { query: "zebra fact" }]),
          step("Two are stale.", ["remember", remember], ["forget", forget], ["forget", elsewhere]),
          TestLLM.text("Done.", "done"),
        )
        yield* h.prompt("zebra?")
        const block = yield* h.blockRecall()
        const [found] = yield* h.searches()
        expect(found?.entries.toSorted()).toEqual([kept, replaced, deleted].toSorted())
        if (!found) return yield* Effect.die(new Error("the recall's search is missing"))
        yield* eventually("both rows were added to", () => h.afters().length === 2)
        // The start block: the first step is the first that sees it.
        expect(h.afters(block).map((call) => call.body)).toEqual([
          {
            step: `Let me look.\nrecall ${json({ query: "zebra fact" })}`,
            acted: [],
            by: { role: "build", chat: h.sessionID },
          },
        ])
        // The recall: the step after its own.
        expect(h.afters(found.recall).map((call) => call.body)).toEqual([
          {
            step: [
              "Two are stale.",
              `remember ${json(remember)}`,
              `forget ${json(forget)}`,
              `forget ${json(elsewhere)}`,
            ].join("\n"),
            acted: [
              { id: replaced, how: "superseded" },
              { id: deleted, how: "forgotten" },
            ],
            by: { role: "build", chat: h.sessionID },
          },
        ])
        const row = yield* Effect.provide(MemoryClient.Service, client).pipe(
          Effect.flatMap((memory) => memory.recall(h.project, found.recall)),
          Effect.orDie,
        )
        expect(row.after).toMatchObject({ step: expect.stringContaining("Two are stale."), person: null })
        expect(row.entries).toContain(kept)
        // The last step followed no search: nothing more is sent.
        yield* Effect.sleep("30 millis")
        expect(h.afters()).toHaveLength(2)
      }),
  )

  it.live("the step's text is cut to 4,000 code points from its start", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const said = "𝄞" + "x".repeat(4_100)
      yield* h.llm.push(TestLLM.text(said, "long"))
      yield* h.prompt("zebra?")
      const block = yield* h.blockRecall()
      yield* eventually("the block's row was added to", () => h.afters(block).length === 1)
      expect((h.afters(block)[0]?.body as { step: string }).step).toBe("𝄞" + "x".repeat(3_999))
    }),
  )

  it.live(
    "the person's next message goes to each search since their message before, the newest 10, and only those",
    () =>
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.write({ kind: "verified", text: "Zebra deploys run at noon.", basis: "cron", scope: "global" })
        yield* h.llm.push(
          step("Looking.", ...Array.from({ length: 11 }, () => ["recall", { query: "zebra" }] as const)),
          TestLLM.text("Found it.", "found"),
        )
        yield* h.prompt("zebra?")
        const block = yield* h.blockRecall()
        const first = yield* h.searches()
        expect(first).toHaveLength(11)
        yield* eventually("the steps' rows were added to", () => h.afters().length === 12)

        yield* h.llm.push(step("Again.", ["recall", { query: "zebra again" }]), TestLLM.text("There.", "there"))
        yield* h.prompt("No, the other one.")
        const second = (yield* h.searches())[11]
        if (!second) return yield* Effect.die(new Error("the second turn's search is missing"))
        // The block and the first of the eleven are older than the newest 10.
        const told = first.slice(1).map((search) => search.recall)
        yield* eventually("the person's message was added", () =>
          told.every((recall) => h.afters(recall).some((call) => "person" in (call.body as object))),
        )
        const people = () =>
          h
            .afters()
            .filter((call) => "person" in (call.body as object))
            .map((call) => call.path.split("/").at(-2))
        yield* Effect.sleep("30 millis")
        expect(people().toSorted()).toEqual(told.toSorted())
        expect(people()).not.toContain(block)
        expect(h.afters(told[0]).find((call) => "person" in (call.body as object))?.body).toEqual({
          person: "No, the other one.",
          by: { role: "build", chat: h.sessionID },
        })

        yield* h.llm.push(TestLLM.text("Ok.", "ok"))
        yield* h.prompt("Thanks.")
        yield* eventually("the second turn's search got it", () =>
          h.afters(second.recall).some((call) => (call.body as { person?: string }).person === "Thanks."),
        )
        yield* Effect.sleep("30 millis")
        expect(people().filter((recall) => recall === second.recall)).toHaveLength(1)
        expect(people()).toHaveLength(11)
      }),
  )

  it.live("takes secrets out of both texts, each as [secret]", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const key = ["sk", "ant", "api03", fill(24)].join("-")
      const token = ["ghp", fill(30)].join("_")
      yield* h.llm.push(TestLLM.text(`The key is ${key}, keep it.`, "key"))
      yield* h.prompt("zebra?")
      const block = yield* h.blockRecall()
      yield* eventually("the block's row was added to", () => h.afters(block).length === 1)
      expect((h.afters(block)[0]?.body as { step: string }).step).toBe("The key is [secret], keep it.")
      yield* h.llm.push(TestLLM.text("Ok.", "ok"))
      yield* h.prompt(`Use ${token} instead`)
      yield* eventually("the person's message was added", () => h.afters(block).length === 2)
      expect((h.afters(block)[1]?.body as { person: string }).person).toBe("Use [secret] instead")
    }),
  )

  it.live("sends nothing while capabilities do not say recalls", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const memory = catalogOf(true).pacer!.memory!
      pacer.catalog = {
        ...catalogOf(true),
        pacer: { ...catalogOf(true).pacer!, memory: { ...memory, recalls: false } },
      }
      yield* h.llm.push(step("Looking.", ["recall", { query: "zebra" }]), TestLLM.text("Done.", "done"))
      yield* h.prompt("zebra?")
      yield* h.llm.push(TestLLM.text("Ok.", "ok"))
      yield* h.prompt("Thanks.")
      expect(h.starts()).toHaveLength(1)
      yield* Effect.sleep("30 millis")
      expect(h.afters()).toEqual([])
    }),
  )

  it.effect("a hanging or failing server never holds up a step: one try, dropped after 2 seconds", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const forward = (request: { method: string; path: string; body: unknown }) =>
        fetch(`${server.store.url}${request.path}`, {
          method: request.method,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        })
      // Every row hangs; the rest goes through.
      const hung = Promise.withResolvers<Response>()
      yield* Effect.addFinalizer(() => Effect.sync(() => hung.resolve(new Response(null, { status: 503 }))))
      server.control.answer = (request) => (request.path.endsWith("/after") ? hung.promise : forward(request))
      yield* h.llm.push(
        step("Looking.", ["recall", { query: "zebra" }]),
        step("Still looking.", ["echo", { text: "one" }]),
        TestLLM.text("Done.", "done"),
      )
      // The clock never moves: a step that waited for a row would never end.
      yield* h.prompt("zebra?")
      expect(h.requests()).toHaveLength(3)
      yield* until("both rows were tried", () => h.afters().length === 2)
      yield* TestClock.adjust("2 seconds")

      // A server that refuses: the chat goes on, and nothing is tried again.
      server.control.answer = (request) =>
        request.path.endsWith("/after")
          ? Response.json({ error: { type: "busy", message: "no free turn" } }, { status: 503 })
          : forward(request)
      yield* h.llm.push(TestLLM.text("Ok.", "ok"))
      yield* h.prompt("Thanks.")
      expect(h.requests()).toHaveLength(4)
      yield* until("the person's message was tried", () => h.afters().length === 4)
      yield* settle
      expect(h.afters()).toHaveLength(4)
    }),
  )
})
