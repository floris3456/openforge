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
import { MemoryTexts } from "@opencode/core/memory/texts"
import { MemoryPromptTable } from "@opencode/core/memory/prompt.sql"
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
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
import { PacerTools } from "@opencode/core/pacer/tools"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { eq } from "drizzle-orm"
import { Context, Effect, Fiber, Layer, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { PacerHttp } from "@opencode/core/pacer/http"
import { testEffect } from "./lib/effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { permissionLayer } from "./lib/permission"
import { settle, until } from "./pacer/fake-tools"
import { texts } from "./pacer/memory-harness"
import {
  catalogOf,
  codeModeList,
  codeModeRoots,
  endpointAt,
  key,
  pacerToolsNode,
  poll,
  primeTools,
  startProxied,
  type Received,
} from "./memory/fixture"
import { startFakeEmbedding } from "./pacer/memory-embedding"

// The start block through the real runner: what each model request holds, over the small memory server. One server
// for the file; each test works in a project of its own.

const server = startProxied()
const defaultServer = server
afterAll(() => server.stop())
/** A server with memory as before prompts were answered: the start block holds the entries nearest the prompt. */
// A server before task plans: these blocks are as they were then.
const today = () => catalogOf(true, { prompt: false, plans: false })

/**
 * What the memory side sees, in the test's hands, as openforge's own services give it: each change is announced, as
 * a live service's catalog read is.
 */
const endpointRef = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpointAt(server.origin)))
const catalogRef = Effect.runSync(SubscriptionRef.make<PacerModels.Catalog | undefined>(today()))
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
// CPP's tools as openforge registers them, the memory tools among them.
const memoryTools = pacerToolsNode("test/memory-start-pacer-tools")
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
    PacerTools.node,
    MemoryTexts.node,
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
    /** The server the chat's memory is on, and its catalog: the file's one, as before prompts were answered. */
    readonly served?: ReturnType<typeof startProxied>
    readonly catalog?: PacerModels.Catalog
    /** The server's `tools.task_codemode`: `task` runs in Code Mode, as its capabilities and its list say. */
    readonly codemode?: boolean
  } = {},
) {
  const server = input.served ?? defaultServer
  pacer.endpoint = endpointAt(server.origin)
  pacer.catalog = input.codemode
    ? catalogOf(true, { prompt: false, plans: false, codemode: ["task"] })
    : (input.catalog ?? today())
  server.reset()
  server.control.answer = input.codemode ? codeModeList(server, ["task"]) : undefined
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
  const inside = undefined as { task: string; subtask?: string } | undefined
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
  // What an earlier chat did once at the endpoint: read a list that named the memory tools, and memory's texts.
  if (pacer.endpoint && pacer.catalog?.pacer?.memory?.tools) {
    yield* primeTools(project)
    const memoryTexts = yield* MemoryTexts.Service
    yield* poll("memory's texts are kept", () => Effect.runSync(memoryTexts.get()) !== undefined)
  }
  const session = yield* Session.Service
  const llm = yield* TestLLM.Test
  const requests = yield* LLMRequests
  const started = requests.length
  return {
    project,
    lead,
    sessionID,
    session,
    llm,
    /** The model requests of this test. */
    requests: () => requests.slice(started),
    /** Writes an entry through the memory API, as a chat of 0.0.42 did. */
    write: (input: Readonly<Record<string, unknown>>, role = "build", where: string = project) =>
      Effect.promise(() =>
        fetch(`${server.store.url}/pacer/v1/memory/${where}/entries`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ ...input, by: by(role) }),
        }).then((answer) => answer.json() as Promise<{ entry: { id: string; text: string; at: number } }>),
      ).pipe(Effect.map((written) => written.entry)),
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
    /** The start blocks' lines in the chat's view (spec notice-view, section 4), in order. */
    lines: () =>
      session
        .messages({ sessionID, order: "asc" })
        .pipe(
          Effect.map((messages) =>
            messages.flatMap((message) =>
              message.type === "synthetic" && message.metadata?.memory !== undefined ? [message.description] : [],
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
    /** The prompt calls of this chat's project. */
    prompts: () => server.calls().filter((call) => call.path === `/pacer/v1/memory/${project}/prompt`),
    /** The prompts recorded as asked without a message. */
    asked: () =>
      db.select().from(MemoryPromptTable).where(eq(MemoryPromptTable.session_id, sessionID)).all().pipe(Effect.orDie),
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
      session
        .messages({ sessionID, order: "asc" })
        .pipe(
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
const blocksIn = (request: LLMRequest | undefined) =>
  userTexts(request).filter((text) => text.startsWith("<system-reminder>\nMemory"))

/** The texts of a request's user-role messages, in order: prompts and synthetic messages alike. */
const userTexts = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )
// Memory's blocks are synthetic messages, which the model gets inside `<system-reminder>` (spec checkpoint, section 1).
const sent = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`
const unsent = (text: string | undefined) => {
  expect(text).toStartWith("<system-reminder>\n")
  expect(text).toEndWith("\n</system-reminder>")
  return (text ?? "").slice("<system-reminder>\n".length, -"\n</system-reminder>".length)
}
/** The start block as the small server's CPP side writes it: CPP's words are CPP's to test. */
const fakeBlock = (
  role: string,
  entries: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  tools = { recall: true, remember: true, task: true },
) =>
  [
    `Memory (fake) for ${role}:`,
    ...entries.map((entry) => `- [${entry.id}] ${entry.text}`),
    `tools: recall ${tools.recall}, remember ${tools.remember}, task ${tools.task}`,
  ].join("\n")
const unavailable = texts.unavailable
const all = ["echo", "forget", "recall", "remember", "task"]

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

      // CPP's block, as its answer gives it: the chat's role's entries and the global ones, the nearer scope first.
      const block = fakeBlock("build", [own, global])
      expect(userTexts(h.requests()[0])).toEqual(["zebra deploys", sent(block)])
      expect(yield* h.blocks()).toEqual([block])
      expect(yield* h.lines()).toEqual(["Memory nearest to the prompt"])
      for (const id of [otherRole.id, otherProject.id]) expect(block).not.toContain(id)
      // Who asks is the headers'; the body names what the agent may use.
      expect(h.starts().map((call) => call.body)).toEqual([
        { prompt: "zebra deploys", limit: 5, tools: { recall: true, remember: true, task: true } },
      ])
      expect(h.starts()[0]?.pacer).toMatchObject({ "x-pacer-agent": "build", "x-pacer-chat": h.sessionID })
      // And the chat's tools are CPP's, from the chat's list.
      expect(names(h.requests()[0])).toEqual(all)
    }),
  )

  it.live("holds at most 5 entries, leaves the middle out when there are none, and cuts the prompt to 2,000", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      for (const n of [1, 2, 3, 4, 5, 6, 7])
        yield* h.write({ kind: "unverified", text: `Quokka note ${n}.`, basis: "b", scope: "role" })
      yield* h.prompt("quokka ".repeat(400))
      const block = unsent(userTexts(h.requests()[0])[1])
      expect(block.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(5)
      expect((h.starts()[0]?.body as { prompt: string }).prompt).toBe("quokka ".repeat(400).slice(0, 2_000))

      const empty = yield* setup()
      yield* empty.prompt("nothing is stored here")
      expect(userTexts(empty.requests()[0])[1]).toBe(sent(fakeBlock("build", [])))
      expect(yield* empty.lines()).toEqual(["Memory"])
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
      const blocks = requests.map((request) =>
        userTexts(request).filter((text) => text.startsWith("<system-reminder>\nMemory (fake)")),
      )
      expect(blocks[0]).toHaveLength(1)
      expect(blocks[1]).toEqual(blocks[0])
      expect(blocks[2]).toEqual(blocks[0])
      expect((yield* h.blocks()).map(sent)).toEqual(blocks[0]!)
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
      yield* h.llm.push(TestLLM.text("At noon.", "noon"))
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
      expect(last.filter((text) => text.startsWith("<system-reminder>\nMemory (fake)"))).toEqual(
        blocks.slice(1, 2).map(sent),
      )
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
      expect(last).toEqual(["zebra deploys?", "walrus lint?", ...blocks.slice(0, 1).map(sent)])
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
      expect(yield* h.blocks()).toEqual([unavailable])
      expect(userTexts(h.requests().at(-1)).at(-1)).toBe(sent(unavailable))
    }),
  )

  it.live("gives a new chat the one line when the server fails, and a chat its old block after a compaction", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      server.control.answer = () =>
        Response.json({ error: { type: "unavailable", message: "store not open" } }, { status: 503 })
      yield* h.prompt("zebra?")
      // CPP's line for memory out of reach, as its texts last said.
      expect(userTexts(h.requests()[0])).toEqual(["zebra?", sent(unavailable)])

      const k = yield* setup()
      yield* k.write({ kind: "verified", text: "Zebra deploys run at noon.", basis: "cron", scope: "global" })
      yield* k.llm.push(TestLLM.text("At noon.", "noon"))
      yield* k.prompt("zebra?")
      const first = (yield* k.blocks())[0]
      yield* k.llm.push(TestLLM.text("## Objective\n- summary", "summary"))
      yield* k.session.compact({ sessionID: k.sessionID })
      yield* k.session.resume(k.sessionID)
      server.control.answer = () => new Response("bad gateway", { status: 502 })
      yield* k.prompt("quokka?")
      expect(yield* k.blocks()).toEqual([first, first])
      expect(
        userTexts(k.requests().at(-1)).filter((text) => text.startsWith("<system-reminder>\nMemory (fake)")),
      ).toEqual([sent(first ?? "")])
    }),
  )

  it.effect("waits at most 2 seconds for the server, then the chat goes on with the one line", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      // Only the start hangs; released however the test ends, so no other test of the file's one server waits on it.
      const hung = Promise.withResolvers<Response>()
      yield* Effect.addFinalizer(() => Effect.sync(() => hung.resolve(new Response(null, { status: 503 }))))
      server.control.answer = (request) => (request.path.endsWith("/start") ? hung.promise : server.pass(request))
      const run = yield* h.prompt("zebra?").pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the start request arrived", () => h.starts().length === 1)
      expect(h.requests()).toHaveLength(0)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)
      expect(userTexts(h.requests()[0])).toEqual(["zebra?", sent(unavailable)])
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
        pacer.catalog = today()
        yield* gate.release
        yield* Fiber.join(run)
        // The tools are the chat's list's, read whatever the catalog; the block goes as the server was last known.
        for (const request of h.requests()) expect(names(request)).toEqual(all)
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
      const block = unsent(userTexts(h.requests()[0])[1])
      expect(block).toContain(own.id)
      expect(block).not.toContain(lead.id)
      expect(block).toStartWith("Memory (fake) for explore:")
      expect(h.starts()[0]?.pacer).toMatchObject({
        "x-pacer-agent": "explore",
        "x-pacer-chat": h.sessionID,
        "x-pacer-parent-session": PacerSessionID.make(h.lead),
      })
    }),
  )

  it.live("tells CPP the chat has no recall when its agent may not use it", () =>
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
        sent(fakeBlock("reader", [own], { recall: false, remember: true, task: true })),
      )
    }),
  )

  it.live("tells CPP the chat cannot save when its agent may not remember", () =>
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
        sent(fakeBlock("viewer", [own], { recall: true, remember: false, task: true })),
      )
    }),
  )

  it.live("has the task tool when it is Code Mode's, and not when only a namespaced one is registered", () =>
    Effect.gen(function* () {
      // CLIProxyPacer's `tools.task_codemode`: `task` is registered in Code Mode, so no direct definition holds it.
      const h = yield* setup({ codemode: true })
      const registry = yield* Tool.Service
      expect(codeModeRoots(registry)).toContain("task")
      yield* h.prompt("make a task")
      expect(h.starts().at(-1)?.body).toEqual({
        prompt: "make a task",
        limit: 5,
        tools: { recall: true, remember: true, task: true },
      })

      // A tool named `task` in a namespace is not the task tool: only the catalog's root is.
      const other = yield* setup({ child: true, agent: "untasked" })
      yield* registry.transform((editor) =>
        editor.add({
          name: "task",
          description: "A namespaced task tool",
          options: { codemode: true, namespace: "x" },
          input: Schema.Struct({ text: Schema.String }),
          execute: () => Effect.succeed({ content: "namespaced" }),
        } satisfies Parameters<Tool.Editor["add"]>[0]),
      )
      yield* other.prompt("make a task")
      expect(other.starts().at(-1)?.body).toEqual({
        prompt: "make a task",
        limit: 5,
        tools: { recall: true, remember: true, task: false },
      })
    }),
  )
})

describe("MemoryStart while the server's memory comes and goes", () => {
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
        pacer.catalog = today()
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

      pacer.catalog = today()
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
      // The call is CPP's to answer, as every call of a tool the chat still has.
      expect(server.received.filter((call) => call.path === "/pacer/v1/tools/recall")).toHaveLength(1)

      const k = yield* setup()
      pacer.catalog = catalogOf(false)
      yield* k.prompt("zebra?")
      expect(names(k.requests()[0])).toEqual(["echo"])
      expect(blocksIn(k.requests()[0])).toEqual([])
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
      pacer.catalog = today()
      yield* h.prompt("and the quokka ones?")
      for (const request of h.requests()) expect(names(request)).toEqual(["echo"])
    }),
  )
})

describe("MemoryStart when CLIProxyPacer keeps the project's memory from the chat", () => {
  const compact = (h: Effect.Success<ReturnType<typeof setup>>) =>
    Effect.gen(function* () {
      yield* h.llm.push(TestLLM.text("## Objective\n- summary", "summary"))
      yield* h.session.compact({ sessionID: h.sessionID })
      yield* h.session.resume(h.sessionID)
    })
  const closed = [
    ["memory off for the project", { memory: false }],
    ["the key not allowed", { memory: true, keys: ["a-key-of-someone-else"] }],
  ] as const

  it.live("names the chat's project and the chat on the start call", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("zebra?")
      expect(h.starts().map((call) => call.pacer)).toEqual([
        {
          "x-pacer-project": h.project,
          "x-pacer-project-name": "project",
          "x-pacer-session": PacerSessionID.make(h.sessionID),
          "x-pacer-agent": "build",
          "x-pacer-chat": h.sessionID,
        },
      ])
    }),
  )

  it.live("gives no block and no memory tools at that step, and the next steps of the span keep them away", () =>
    Effect.gen(function* () {
      for (const [label, setting] of closed) {
        const h = yield* setup()
        yield* h.write({ kind: "verified", text: "Zebra deploys run at noon.", basis: "cron", scope: "global" })
        server.store.project(h.project, setting)
        yield* h.llm.push(TestLLM.toolCall("call-1", "echo", { text: "one" }), TestLLM.text("done", "text-done"))
        yield* h.prompt("zebra deploys?")
        yield* h.prompt("and on fridays?")
        const requests = h.requests()
        expect({ label, steps: requests.length }).toEqual({ label, steps: 3 })
        for (const request of requests) {
          expect({ label, tools: names(request) }).toEqual({ label, tools: ["echo"] })
          expect({ label, blocks: blocksIn(request) }).toEqual({ label, blocks: [] })
        }
        expect({ label, stored: yield* h.blocks() }).toEqual({ label, stored: [] })
        // Asked once, at the chat's cold point.
        expect({ label, starts: h.starts().length }).toEqual({ label, starts: 1 })
      }
    }),
  )

  it.live("a project turned on reaches the chat only at its next cold point, with the block and the tools", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.write({ kind: "verified", text: "Zebra deploys run at noon.", basis: "cron", scope: "global" })
      server.store.project(h.project, { memory: false })
      yield* h.llm.push(TestLLM.text("no zebras", "text-zebra"))
      yield* h.prompt("zebra deploys?")
      server.store.project(h.project, { memory: true })
      yield* h.prompt("and on fridays?")
      expect(h.requests().map(names)).toEqual([["echo"], ["echo"]])
      expect(h.starts()).toHaveLength(1)

      yield* compact(h)
      yield* h.prompt("when do zebra deploys run?")
      const after = h.requests().at(-1)
      expect(names(after)).toEqual(["echo", "forget", "recall", "remember", "task"])
      expect(blocksIn(after)).toHaveLength(1)
      expect(blocksIn(after)[0]).toContain("Zebra deploys run at noon.")
      expect(h.starts()).toHaveLength(2)
    }),
  )

  it.live("a project turned off reaches a chat with memory only at its next cold point, which then has none", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.llm.push(TestLLM.text("zebras", "text-zebra"))
      yield* h.prompt("zebra?")
      const first = h.requests()[0]
      expect(names(first)).toEqual(["echo", "forget", "recall", "remember", "task"])
      server.store.project(h.project, { memory: false })
      yield* h.prompt("and on fridays?")
      expect(JSON.stringify(h.requests().at(-1)?.tools)).toBe(JSON.stringify(first?.tools))

      yield* compact(h)
      yield* h.prompt("quokka?")
      const after = h.requests().at(-1)
      expect(names(after)).toEqual(["echo"])
      expect(blocksIn(after)).toEqual([])
    }),
  )

  it.live("a 500, or memory off for the whole server, gives CPP's unavailable block; the tools stay the list's", () =>
    Effect.gen(function* () {
      for (const answer of [
        () => Response.json({ error: { type: "internal", message: "boom" } }, { status: 500 }),
        () => Response.json({ error: { type: "not_found", message: "memory is off" } }, { status: 404 }),
      ]) {
        const h = yield* setup()
        server.control.answer = (request) => (request.path.endsWith("/start") ? answer() : server.pass(request))
        yield* h.prompt("zebra?")
        expect(userTexts(h.requests()[0])).toEqual(["zebra?", sent(unavailable)])
        expect(names(h.requests()[0])).toEqual(["echo", "forget", "recall", "remember", "task"])
      }
    }),
  )
})

describe("MemoryPrompt through the runner", () => {
  // A server that answers prompts, with meaning: the fake endpoint's vectors make "release" and "ship" one concept.
  const embedding = startFakeEmbedding()
  const prompted = startProxied({ embedding: embedding.url })
  afterAll(() => prompted.stop().then(() => embedding.stop()))
  const near = (input: Parameters<typeof setup>[0] = {}) =>
    setup({ ...input, served: prompted, catalog: catalogOf(true, { plans: false }) })
  const line = "Memory close to the prompt (fake):"
  const entry = (item: { readonly id: string; readonly text: string }) => `- [${item.id}] ${item.text}`
  /** The user-role texts of a request as a provider gets them, roles and texts only, up to and with `prompt`. */
  const upTo = (request: LLMRequest | undefined, prompt: string) => {
    const messages = (request?.messages ?? []).map((message) => ({ role: message.role, content: message.content }))
    const at = messages.findIndex((message) =>
      JSON.stringify(message.content).includes(JSON.stringify(prompt).slice(1, -1)),
    )
    return JSON.stringify({ system: request?.system, tools: request?.tools, messages: messages.slice(0, at + 1) })
  }

  it.live("the start asks for no entries and the block holds none; a close entry comes right after the prompt", () =>
    Effect.gen(function* () {
      const h = yield* near()
      const close = yield* h.write({
        kind: "verified",
        text: "Releases ship through the train.",
        basis: "b",
        scope: "global",
      })
      yield* h.write({ kind: "verified", text: "Zebra lint is strict.", basis: "b", scope: "global" })
      yield* h.llm.push(TestLLM.toolCall("call-1", "echo", { text: "one" }), TestLLM.text("done", "text-done"))
      yield* h.prompt("how do we release")

      const block = fakeBlock("build", [])
      // CPP's message of the close entries, as its answer gives it.
      const message = [line, entry(close)].join("\n")
      const requests = h.requests()
      expect(requests).toHaveLength(2)
      // The step that answers no new prompt sends the same, and asks nothing.
      for (const request of requests)
        expect(userTexts(request)).toEqual(["how do we release", sent(block), sent(message)])
      expect((h.starts()[0]?.body as { limit: number }).limit).toBe(0)
      expect(yield* h.lines()).toEqual(["Memory"])
      // Who asks is the headers'.
      expect(h.prompts().map((call) => call.body)).toEqual([{ prompt: "how do we release", exclude: [] }])
      expect(h.prompts().map((call) => call.pacer)).toEqual([
        {
          "x-pacer-project": h.project,
          "x-pacer-project-name": "project",
          "x-pacer-session": PacerSessionID.make(h.sessionID),
          "x-pacer-agent": "build",
          "x-pacer-chat": h.sessionID,
        },
      ])
      // Recorded by its message: no row of its own.
      expect(yield* h.asked()).toEqual([])
    }),
  )

  it.live("asks once for each prompt, leaves out the entries in view, and puts nothing in when none is close", () =>
    Effect.gen(function* () {
      const h = yield* near()
      const first = yield* h.write({
        kind: "verified",
        text: "Releases ship through the train.",
        basis: "b",
        scope: "global",
      })
      yield* h.prompt("how do we release")
      yield* h.prompt("zebra lint")
      const second = yield* h.write({
        kind: "verified",
        text: "A release is tagged first.",
        basis: "b",
        scope: "global",
      })
      yield* h.prompt("and the release tag?")

      expect(h.prompts().map((call) => (call.body as { exclude: string[] }).exclude)).toEqual([
        [],
        [first.id],
        [first.id],
      ])
      const last = userTexts(h.requests().at(-1))
      expect(last.filter((text) => text.startsWith(`<system-reminder>\n${line}`))).toEqual([
        sent([line, entry(first)].join("\n")),
        sent([line, entry(second)].join("\n")),
      ])
      // Nothing after the prompt no entry was close to: the next text is the prompt after it.
      expect(last[last.indexOf("zebra lint") + 1]).toBe("and the release tag?")
      expect((yield* h.asked()).map((row) => row.project)).toEqual([h.project])
    }),
  )

  it.live("the request's bytes up to the prompt are the same with the message after it and without", () =>
    Effect.gen(function* () {
      const twins = []
      for (const answer of [true, false]) {
        const h = yield* near()
        yield* h.write({ kind: "verified", text: "Releases ship through the train.", basis: "b", scope: "global" })
        yield* h.llm.push(TestLLM.text("Looked.", "looked"))
        yield* h.prompt("zebra lint")
        if (!answer)
          prompted.control.answer = (request) =>
            request.path.endsWith("/prompt")
              ? Response.json({ recall: null, entries: [], meaning: true, text: null })
              : prompted.pass(request)
        yield* h.prompt("how do we release")
        prompted.control.answer = undefined
        const request = h.requests().at(-1)
        expect(userTexts(request).some((text) => text.startsWith(`<system-reminder>\n${line}`))).toBe(answer)
        twins.push(upTo(request, "how do we release"))
        // Nothing earlier changes: the step before sent what this one sends before its new messages.
        const before = h.requests().at(-2)
        expect(JSON.stringify(request?.messages.slice(0, before?.messages.length ?? 0).map((m) => m.content))).toBe(
          JSON.stringify(before?.messages.map((m) => m.content)),
        )
      }
      expect(twins[0]).toBe(twins[1])
    }),
  )

  it.live("a prompt is asked once however often a step for it starts again, as after a restart", () =>
    Effect.gen(function* () {
      const h = yield* near()
      // A reply with nothing in it leaves no step in the chat, so the prompt stays the newest: what the record is for.
      yield* h.prompt("zebra lint")
      yield* h.session.resume(h.sessionID)
      yield* h.session.resume(h.sessionID)
      expect(h.requests()).toHaveLength(3)
      expect(h.prompts()).toHaveLength(1)
      expect((yield* h.asked()).length).toBe(1)
    }),
  )

  it.effect("waits at most 2 seconds, and a timeout, an error or memory closed put nothing in", () =>
    Effect.gen(function* () {
      const h = yield* near()
      yield* h.write({ kind: "verified", text: "Releases ship through the train.", basis: "b", scope: "global" })
      yield* h.prompt("zebra lint")
      const forward = (request: Received) => prompted.pass(request)
      const hung = Promise.withResolvers<Response>()
      yield* Effect.addFinalizer(() => Effect.sync(() => hung.resolve(new Response(null, { status: 503 }))))
      prompted.control.answer = (request) => (request.path.endsWith("/prompt") ? hung.promise : forward(request))
      const run = yield* h.prompt("how do we release").pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the prompt call arrived", () => h.prompts().length === 2)
      expect(h.requests()).toHaveLength(1)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)
      for (const answer of [
        () => Response.json({ error: { type: "internal", message: "boom" } }, { status: 500 }),
        () =>
          Response.json(
            { error: { type: "project_memory_off", message: "memory is off for this project" } },
            { status: 404 },
          ),
      ]) {
        prompted.control.answer = (request) => (request.path.endsWith("/prompt") ? answer() : forward(request))
        yield* h.prompt("how do we release again")
      }
      prompted.control.answer = undefined
      expect(h.prompts()).toHaveLength(4)
      expect(h.requests()).toHaveLength(4)
      for (const request of h.requests())
        expect(userTexts(request).some((text) => text.startsWith(`<system-reminder>\n${line}`))).toBe(false)
      expect((yield* h.asked()).map((row) => row.recall)).toEqual([expect.any(String), null, null, null])
    }),
  )

  it.live("what followed goes to the prompt's row, with a message or without", () =>
    Effect.gen(function* () {
      const h = yield* near()
      yield* h.write({ kind: "verified", text: "Releases ship through the train.", basis: "b", scope: "global" })
      yield* h.llm.push(TestLLM.text("By train.", "train"))
      yield* h.prompt("how do we release")
      yield* h.llm.push(TestLLM.text("No idea.", "idea"))
      yield* h.prompt("zebra lint")
      const messaged = (yield* h.session.messages({ sessionID: h.sessionID, order: "asc" })).flatMap((message) =>
        message.type === "synthetic" && message.metadata?.memoryPrompt
          ? [(message.metadata.memoryPrompt as { recall: string }).recall]
          : [],
      )
      const rows = (yield* h.asked()).map((row) => row.recall!)
      expect(messaged).toHaveLength(1)
      expect(rows).toHaveLength(1)
      const afters = (recall: string) =>
        prompted.calls().filter((call) => call.path.endsWith(`/recalls/${recall}/after`))
      yield* eventually(
        "both rows got their step",
        () => afters(messaged[0]!).length >= 1 && afters(rows[0]!).length === 1,
      )
      yield* eventually("the first row got the person's next message", () => afters(messaged[0]!).length === 2)
      expect(afters(messaged[0]!).map((call) => call.body)).toEqual([
        { step: "By train.", acted: [], by: { role: "build", chat: h.sessionID } },
        { person: "zebra lint", by: { role: "build", chat: h.sessionID } },
      ])
      expect(afters(rows[0]!).map((call) => call.body)).toEqual([
        { step: "No idea.", acted: [], by: { role: "build", chat: h.sessionID } },
      ])
    }),
  )

  it.live("asks nothing on a server without prompt, in a chat without memory, or with memory closed", () =>
    Effect.gen(function* () {
      const old = yield* setup({ served: prompted, catalog: today() })
      yield* old.write({ kind: "verified", text: "Releases ship through the train.", basis: "b", scope: "global" })
      yield* old.prompt("how do we release")
      expect(old.prompts()).toEqual([])
      expect(userTexts(old.requests()[0])[1]).toContain("Releases ship through the train.")
      expect((old.starts()[0]?.body as { limit: number }).limit).toBe(5)

      const closed = yield* near()
      prompted.store.project(closed.project, { memory: false })
      yield* closed.prompt("how do we release")
      expect(closed.starts()).toHaveLength(1)
      expect(closed.prompts()).toEqual([])

      const none = yield* near()
      pacer.catalog = catalogOf(false)
      yield* none.prompt("how do we release")
      expect(prompted.calls().filter((call) => call.path.includes(none.project))).toEqual([])
    }),
  )
})

describe("MemoryStart after a compaction: the summary", () => {
  // A server that answers prompts and summaries, with meaning: the fake endpoint's vectors make "release" and "ship" one
  // concept, so the summary's part on shipping is close to the entry on releases and its other part to nothing.
  const embedding = startFakeEmbedding()
  const summarized = startProxied({ embedding: embedding.url })
  afterAll(() => summarized.stop().then(() => embedding.stop()))
  const near = (input: Parameters<typeof setup>[0] = {}) =>
    setup({ served: summarized, catalog: catalogOf(true, { plans: false }), ...input })
  /** What the block holds after a compaction: CPP's text of the entries close to the summary. */
  const closeTo = (entries: ReadonlyArray<{ readonly id: string; readonly text: string }>) =>
    fakeBlock("build", entries)
  const summary = "Before any heading.\n\n## Objective\nShip it soon.\n\n## Empty\n\n## Next\n- zebra lint"
  type Started = { prompt: string; limit: number; summary?: string[]; exclude?: string[] }
  const bodies = (h: Effect.Success<ReturnType<typeof setup>>) => h.starts().map((call) => call.body as Started)
  /** A chat that had a first prompt and a compaction with `summary`, and the entry close to it. */
  const compacted = Effect.fnUntraced(function* (input: Parameters<typeof setup>[0] = {}) {
    const h = yield* near(input)
    const close = yield* h.write({
      kind: "verified",
      text: "Releases ship through the train.",
      basis: "b",
      scope: "global",
    })
    yield* h.llm.push(TestLLM.text("Strict.", "strict"))
    yield* h.prompt("zebra lint?")
    yield* h.llm.push(TestLLM.text(summary, "summary"))
    yield* h.session.compact({ sessionID: h.sessionID })
    return { h, close }
  })

  it.live("the block after a compaction holds the entries close to its summary, the same in every later step", () =>
    Effect.gen(function* () {
      const { h, close } = yield* compacted()
      yield* h.llm.push(TestLLM.toolCall("call-1", "echo", { text: "one" }), TestLLM.text("done", "text-done"))
      yield* h.session.resume(h.sessionID)
      yield* h.prompt("what now?")

      const [first, again] = bodies(h)
      // A chat's first block has no summary to search.
      expect(first).not.toHaveProperty("summary")
      expect(first).not.toHaveProperty("exclude")
      expect(again).toMatchObject({
        limit: 0,
        summary: ["Before any heading.", "## Objective\nShip it soon.", "## Next\n- zebra lint"],
        exclude: [],
      })
      const blocks = yield* h.blocks()
      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toBe(fakeBlock("build", []))
      expect(blocks[1]).toBe(closeTo([close]))
      expect(yield* h.lines()).toEqual(["Memory", "Memory close to the summary"])
      // Every step after the compaction sends the block as it was built.
      const after = h.requests().filter((request) => userTexts(request).includes(sent(blocks[1]!)))
      expect(after.length).toBeGreaterThanOrEqual(2)
      for (const request of after)
        expect(userTexts(request).filter((text) => text.startsWith("<system-reminder>\nMemory (fake)"))).toEqual([
          sent(blocks[1]!),
        ])
      // Its entries are in view: a later prompt leaves them out.
      expect(
        h
          .prompts()
          .map((call) => (call.body as { exclude: string[] }).exclude)
          .at(-1),
      ).toContain(close.id)
      // The summary's row is the block's.
      const recall = yield* h.blockRecall()
      const read = yield* Effect.promise(() =>
        fetch(`${summarized.store.url}/pacer/v1/memory/${h.project}/recalls/${recall}`, {
          headers: { authorization: `Bearer ${key}` },
        }).then((response) => response.json() as Promise<{ recall: { kind: string; entries: string[] } }>),
      )
      expect(read.recall).toMatchObject({ kind: "summary", entries: [close.id], said: [] })
    }),
  )

  it.live("without an entry close to the summary the block has no line", () =>
    Effect.gen(function* () {
      const h = yield* near()
      yield* h.write({ kind: "verified", text: "Zebra lint is strict.", basis: "b", scope: "global" })
      yield* h.llm.push(TestLLM.text("Hello.", "hello"))
      yield* h.prompt("hello")
      yield* h.llm.push(TestLLM.text("## Objective\nPaint the shed.", "summary"))
      yield* h.session.compact({ sessionID: h.sessionID })
      yield* h.session.resume(h.sessionID)
      yield* h.prompt("what now?")
      expect(bodies(h)[1]?.summary).toEqual(["## Objective\nPaint the shed."])
      expect((yield* h.blocks())[1]).toBe(closeTo([]))
      expect((yield* h.lines())[1]).toBe("Memory · nothing close to the summary")
    }),
  )

  it.live("an entry close to the summary that it already says is left out, and the line says so", () =>
    Effect.gen(function* () {
      const h = yield* near()
      const said = yield* h.write({ kind: "verified", text: "Ship it soon.", basis: "b", scope: "global" })
      yield* h.llm.push(TestLLM.text("Hello.", "hello"))
      yield* h.prompt("hello")
      yield* h.llm.push(TestLLM.text(summary, "summary"))
      yield* h.session.compact({ sessionID: h.sessionID })
      yield* h.session.resume(h.sessionID)
      yield* h.prompt("what now?")
      // The model gets the block as when nothing is close: only the line in the chat's view tells them apart.
      expect((yield* h.blocks())[1]).toBe(closeTo([]))
      expect((yield* h.lines())[1]).toBe("Memory · the summary already says the 1 entry close to it")
      expect(bodies(h)[1]?.summary).toBeDefined()
      const recall = yield* h.blockRecall()
      const read = yield* Effect.promise(() =>
        fetch(`${summarized.store.url}/pacer/v1/memory/${h.project}/recalls/${recall}`, {
          headers: { authorization: `Bearer ${key}` },
        }).then((response) => response.json() as Promise<{ recall: { kind: string; entries: string[] } }>),
      )
      expect(read.recall).toMatchObject({ kind: "summary", entries: [], said: [said.id] })
    }),
  )

  it.live("a server that names no said entries gives the line without saying why none came", () =>
    Effect.gen(function* () {
      const h = yield* near()
      yield* h.write({ kind: "verified", text: "Ship it soon.", basis: "b", scope: "global" })
      // As CLIProxyPacer before it answered `said`.
      summarized.control.answer = (request) =>
        summarized.pass(request).then(async (response) => {
          if (!request.path.endsWith("/start")) return response
          const { said: _, ...rest } = (await response.json()) as Record<string, unknown>
          return Response.json(rest, { status: response.status })
        })
      yield* h.llm.push(TestLLM.text("Hello.", "hello"))
      yield* h.prompt("hello")
      yield* h.llm.push(TestLLM.text(summary, "summary"))
      yield* h.session.compact({ sessionID: h.sessionID })
      yield* h.session.resume(h.sessionID)
      yield* h.prompt("what now?")
      expect(bodies(h)[1]?.summary).toBeDefined()
      expect(yield* h.lines()).toEqual(["Memory", "Memory"])
    }),
  )

  it.live("leaves out the entries the chat still has in view among the messages the compaction kept", () =>
    Effect.gen(function* () {
      const h = yield* near()
      const close = yield* h.write({
        kind: "verified",
        text: "Releases ship through the train.",
        basis: "b",
        scope: "global",
      })
      yield* h.prompt("zebra lint?")
      yield* h.llm.push(TestLLM.text("By train.", "train"))
      // Its prompt message puts the entry in view, in the latest exchange, which the compaction keeps.
      yield* h.prompt("how do we release")
      yield* h.llm.push(TestLLM.text(summary, "summary"))
      yield* h.session.compact({ sessionID: h.sessionID })
      yield* h.session.resume(h.sessionID)
      yield* h.prompt("what now?")
      const kept = (yield* h.session.messages({ sessionID: h.sessionID, order: "asc" })).find(
        (message) => message.type === "compaction",
      )?.metadata?.keepID
      expect(kept).toBeDefined()
      expect(bodies(h)[1]?.exclude).toEqual([close.id])
      expect((yield* h.blocks())[1]).toBe(closeTo([]))
    }),
  )

  it.effect("waits at most 5 seconds for the summary; a timeout or an error give the block without the line", () =>
    Effect.gen(function* () {
      const forward = (request: Received) => summarized.pass(request)
      const withSummary = (request: { path: string; body: unknown }) =>
        request.path.endsWith("/start") && (request.body as Started).summary !== undefined
      const { h } = yield* compacted()
      const hung = Promise.withResolvers<Response>()
      yield* Effect.addFinalizer(() => Effect.sync(() => hung.resolve(new Response(null, { status: 503 }))))
      summarized.control.answer = (request) => (withSummary(request) ? hung.promise : forward(request))
      const run = yield* h.prompt("what now?").pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the start with the summary arrived", () => h.starts().length === 2)
      yield* TestClock.adjust("2 seconds")
      expect(h.starts()).toHaveLength(2)
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.join(run)
      // Asked again without the summary: the block as without one.
      expect(bodies(h).map((body) => body.summary !== undefined)).toEqual([false, true, false])
      expect((yield* h.blocks())[1]).toBe(closeTo([]))
      expect((yield* h.lines())[1]).toBe("Memory")

      const { h: k } = yield* compacted()
      summarized.control.answer = (request) =>
        withSummary(request)
          ? Response.json({ error: { type: "invalid_request", message: "summary: no" } }, { status: 400 })
          : forward(request)
      yield* k.prompt("what now?")
      summarized.control.answer = undefined
      expect(bodies(k).map((body) => body.summary !== undefined)).toEqual([false, true, false])
      expect((yield* k.blocks())[1]).toBe(closeTo([]))
    }),
  )

  it.live("a server without summary gets no parts", () =>
    Effect.gen(function* () {
      const { h } = yield* compacted({ catalog: catalogOf(true, { summary: false, plans: false }) })
      yield* h.prompt("what now?")
      expect(bodies(h).map((body) => [body.limit, body.summary, body.exclude])).toEqual([
        [0, undefined, undefined],
        [0, undefined, undefined],
      ])
      expect((yield* h.blocks())[1]).toBe(closeTo([]))
    }),
  )

  it.live("what followed the block goes to the summary's row, with the entry the step replaced", () =>
    Effect.gen(function* () {
      const { h, close } = yield* compacted()
      const remember = {
        text: "Releases ship by train, corrected.",
        kind: "verified",
        basis: "b",
        supersedes: close.id,
      }
      yield* h.llm.push(step("It is stale.", ["remember", remember]), TestLLM.text("Done.", "done"))
      yield* h.prompt("what now?")
      const recall = yield* h.blockRecall()
      yield* eventually("the summary's row got its step", () => h.afters(recall).length >= 1)
      expect(h.afters(recall)[0]?.body).toEqual({
        step: `It is stale.\nremember ${json(remember)}`,
        acted: [{ id: close.id, how: "superseded" }],
        by: { role: "build", chat: h.sessionID },
      })
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
describe("MemoryFollowed through the runner", () => {
  it.live("names the chat to CPP on the start call and what followed, a subagent's with its lead's", () =>
    Effect.gen(function* () {
      const lead = yield* setup()
      let project = lead.project
      const as = (sessionID: Session.ID, parentID?: Session.ID) => ({
        "x-pacer-project": project,
        "x-pacer-project-name": "project",
        "x-pacer-session": PacerSessionID.make(sessionID),
        ...(parentID ? { "x-pacer-parent-session": PacerSessionID.make(parentID) } : {}),
      })
      yield* lead.llm.push(TestLLM.text("Looking.", "looking"))
      yield* lead.prompt("zebra?")
      const block = yield* lead.blockRecall()
      yield* eventually("the step's row was added to", () => lead.afters(block).length === 1)
      yield* lead.llm.push(TestLLM.text("Ok.", "ok"))
      yield* lead.prompt("The other one.")
      yield* eventually("the person's message was added", () => lead.afters(block).length === 2)
      // The start names who asks too; what followed carries it in its body, as the memory API takes it.
      const asking = (sessionID: Session.ID, agent: string, parentID?: Session.ID) => ({
        ...as(sessionID, parentID),
        "x-pacer-agent": agent,
        "x-pacer-chat": sessionID,
      })
      expect(lead.starts().map((call) => call.pacer)).toEqual([asking(lead.sessionID, "build")])
      expect(lead.afters().map((call) => call.pacer)).toEqual([as(lead.sessionID), as(lead.sessionID)])
      // `by.chat` stays the session's own ID.
      expect(lead.afters().map((call) => (call.body as { by: { chat: string } }).by.chat)).toEqual([
        lead.sessionID,
        lead.sessionID,
      ])

      const child = yield* setup({ child: true, agent: "explore" })
      project = child.project
      yield* child.llm.push(TestLLM.text("In src.", "src"))
      yield* child.prompt("where are the zebra files?")
      const its = yield* child.blockRecall()
      yield* eventually("the subagent's step was added", () => child.afters(its).length === 1)
      expect(child.starts().map((call) => call.pacer)).toEqual([asking(child.sessionID, "explore", child.lead)])
      expect(child.afters().map((call) => call.pacer)).toEqual([as(child.sessionID, child.lead)])
    }),
  )

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

  it.live("sends nothing while capabilities do not say recalls", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const memory = today().pacer!.memory!
      pacer.catalog = {
        ...today(),
        pacer: { ...today().pacer!, memory: { ...memory, recalls: false } },
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
      const forward = (request: Received) => server.pass(request)
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
