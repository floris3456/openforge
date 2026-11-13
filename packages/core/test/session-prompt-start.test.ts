import { describe, expect } from "bun:test"
import { LanguageModel, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
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
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerWarmth } from "@opencode/core/pacer/warmth"
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
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionPromptStart } from "@opencode/core/session/prompt-start"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { Document, Info } from "@opencode/schema/config"
import { Provider } from "@opencode/schema/provider"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Effect, Layer, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { permissionLayer } from "./lib/permission"

// A warm chat's prompt never changes (the workspace's spec `docs/specs/frozen-prefix.md`): what each model request
// starts with, through the real runner, as things change between its steps.

const catalogRef = Effect.runSync(SubscriptionRef.make<PacerModels.Catalog | undefined>(undefined))
const endpointRef = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(undefined))
const configs = Effect.runSync(Layer.build(Config.testLayer()).pipe(Effect.scoped))
const config = Context.get(configs, Config.Test)
const warmth = Context.get(Effect.runSync(Layer.build(PacerWarmth.layer).pipe(Effect.scoped)), PacerWarmth.Service)
/** CPP's catalog with or without `pacer.freeze_prompt` off. */
const catalogOf = (freezePrompt: boolean): PacerModels.Catalog => ({
  at: 0,
  pacer: { compactTokens: ["auto"], webTools: false, freezePrompt },
  models: [],
})

class LLMRequests extends Context.Service<LLMRequests, LLMRequest[]>()("test/PromptStartRequests") {}
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

// The chat's own model, as `switchModel` sets it.
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) =>
    Effect.succeed(
      SessionRunnerModel.resolved(
        LanguageModel.make({
          id: session.model?.id ?? "fake-model",
          provider: session.model?.providerID ?? "fake",
          route: OpenAIChat.route,
        }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
        },
      ),
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
const echo = {
  name: "echo",
  description: "Echo text",
  options: { codemode: false },
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ text }: { text: string }) => Effect.succeed({ output: { text }, content: text }),
} satisfies Parameters<Tool.Editor["add"]>[0]
const echoNode = makeLocationNode({
  name: "test/prompt-start-tools",
  layer: Layer.effectDiscard(Tool.Service.use((registry) => registry.transform((editor) => editor.add(echo)))),
  deps: [Tool.node],
})
const replacements: LayerNode.Replacements = [
  Database.node.replace(Database.layer().pipe(Layer.provide(Global.layerWith({})))),
  Snapshot.node.replace(Snapshot.noopLayer),
  LayerNodePlatform.llmClient.replace(testLLM),
  SessionRunnerModel.node.replace(models),
  InstructionBuiltIns.node.replace(Layer.mock(InstructionBuiltIns.Service, none)),
  InstructionDiscovery.node.replace(Layer.mock(InstructionDiscovery.Service, { project: true, global: true, ...none })),
  SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, none)),
  ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, none)),
  McpInstructions.node.replace(Layer.mock(McpInstructions.Service, none)),
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  Config.node.replace(Layer.succeedContext(configs)),
  Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
  PluginSupervisor.node.replace(Layer.empty),
  Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
  PacerEndpoint.node.replace(endpoints),
  PacerModels.node.replace(catalogs),
  PacerWarmth.node.replace(Layer.succeed(PacerWarmth.Service, warmth)),
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
    echoNode,
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

const BASE = [
  "You are the build agent.",
  "Work carefully.",
  ...Array.from({ length: 30 }, (_, index) => `Rule ${index + 1}: keep to the project's conventions.`),
].join("\n")
const cpp = Model.Ref.make({ providerID: Provider.ID.make("cliproxypacer"), id: Model.ID.make("claude-cpp") })

/** A chat in a project of its own, with what the model got and what changes between its steps. */
const setup = Effect.fnUntraced(function* (input: { readonly parent?: Session.ID; readonly model?: Model.Ref } = {}) {
  yield* SubscriptionRef.set(catalogRef, undefined)
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  const tools = yield* Tool.Service
  yield* config.setEntries([])
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
      agent.system = BASE
    })
    editor.update(Agent.ID.make("plan"), (agent) => {
      agent.mode = "primary"
      agent.system = "You are the plan agent."
    })
    editor.update(Agent.ID.make("explore"), (agent) => {
      agent.mode = "subagent"
      agent.system = "You explore."
    })
  })
  const project = Project.ID.make(crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"))
  yield* db
    .insert(ProjectTable)
    .values({ id: project, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const insert = (id: Session.ID, parent?: Session.ID, agent?: string) =>
    db
      .insert(SessionTable)
      .values({
        id,
        ...(parent ? { parent_id: parent } : {}),
        ...(agent ? { agent: Agent.ID.make(agent) } : {}),
        ...(input.model ? { model: { id: input.model.id, providerID: input.model.providerID } } : {}),
        project_id: project,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  const sessionID = Session.ID.make(`ses_start_${project.slice(0, 12)}${input.parent ? "_child" : ""}`)
  yield* insert(sessionID, input.parent, input.parent ? "explore" : undefined)
  const session = yield* Session.Service
  const llm = yield* TestLLM.Test
  const requests = yield* LLMRequests
  const started = requests.length
  return {
    sessionID,
    session,
    llm,
    /** The model requests of this test. */
    requests: () => requests.slice(started),
    prompt: (text: string) =>
      session.prompt({ sessionID, text, resume: false }).pipe(Effect.andThen(session.resume(sessionID))),
    compact: Effect.gen(function* () {
      yield* llm.push(TestLLM.text("## Objective\n- summary", "summary"))
      yield* session.compact({ sessionID })
      yield* session.resume(sessionID)
    }),
    prompted: (system: string) =>
      agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.system = system
        }),
      ),
    tools: (edit: (editor: Tool.Editor) => void) => tools.transform(edit),
    /** The reminders the chat holds, in order. */
    reminders: () =>
      session
        .messages({ sessionID, order: "asc" })
        .pipe(
          Effect.map((messages) =>
            messages.flatMap((message) =>
              message.type === "synthetic" && message.metadata?.promptStart === true ? [message.text] : [],
            ),
          ),
        ),
  }
})

/** What a request sends before the chat's messages: its system parts and tool definitions, as JSON. */
const startOf = (request: LLMRequest | undefined) => JSON.stringify({ system: request?.system, tools: request?.tools })
const systemOf = (request: LLMRequest | undefined) => request?.system[0]?.text
const names = (request: LLMRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name)
const texts = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )
const schemaOf = (request: LLMRequest | undefined, name: string) =>
  JSON.stringify(
    request?.tools.flatMap((tool) => (tool.type === "tool" && tool.name === name ? [tool.inputSchema] : []))[0],
  )
const header =
  "While this chat's prompt cache is warm, its system prompt and tool list stay as they were sent; these changes apply from now on, and come into them at its next cold point:"
const extra = (description = "An extra tool") =>
  ({
    name: "extra",
    description,
    options: { codemode: false },
    input: Schema.Struct({ value: Schema.String }),
    execute: () => Effect.succeed({ content: "extra" }),
  }) satisfies Parameters<Tool.Editor["add"]>[0]

describe("SessionPromptStart: a warm chat's start between two steps", () => {
  it.live("stays byte for byte when the agent's prompt changes, and one reminder gives the changed passage", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.prompted(BASE.replace("Work carefully.", "Work very carefully."))
      yield* h.prompt("two")
      yield* h.prompt("three")
      const [first, second, third] = h.requests()
      expect(systemOf(first)).toBe(BASE)
      expect(startOf(second)).toBe(startOf(first))
      expect(startOf(third)).toBe(startOf(first))
      const reminders = yield* h.reminders()
      expect(reminders).toHaveLength(1)
      expect(reminders[0]).toStartWith(`${header}\n\nThe agent's prompt changed; the new passages apply from now on.`)
      expect(reminders[0]).toContain("-Work carefully.\n+Work very carefully.")
      // After the history, in the step that follows the change and in every one after it.
      expect(texts(second)).toEqual(["one", "two", reminders[0]])
      expect(texts(third)).toEqual(["one", "two", reminders[0], "three"])
    }),
  )

  it.live("gives the whole new prompt when that is shorter than the changes", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.prompted("Be brief.")
      yield* h.prompt("two")
      expect(startOf(h.requests()[1])).toBe(startOf(h.requests()[0]))
      expect(yield* h.reminders()).toEqual([`${header}\n\nThe agent's prompt changed; from now on it is:\nBe brief.`])
    }),
  )

  it.live("stays when a tool comes, goes or changes its description; each reminder covers what changed since", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.tools((editor) => editor.add(extra()))
      yield* h.prompt("two")
      yield* h.tools((editor) => editor.update("echo", (tool) => (tool.description = "Echo text, loudly")))
      yield* h.prompt("three")
      yield* h.tools((editor) => editor.remove("echo"))
      yield* h.prompt("four")
      const requests = h.requests()
      expect(names(requests[0])).toEqual(["echo", "execute"])
      for (const request of requests.slice(1)) expect(startOf(request)).toBe(startOf(requests[0]))
      expect(yield* h.reminders()).toEqual([
        `${header}\n\nA new tool, extra, comes with this chat's next cold point (such as a compaction); until then it is in no list you have.`,
        `${header}\n\nThe tool echo changed; its calls follow this from now on:\nDescription: Echo text, loudly\nInput: ${schemaOf(requests[0], "echo")}`,
        `${header}\n\nThe tool echo is gone: its calls answer that it is unavailable.`,
      ])
    }),
  )

  it.live("gives no reminder when a reload hands new definitions that read the same", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.tools((editor) => editor.update("echo", (tool) => (tool.description = "Echo text, loudly")))
      yield* h.tools((editor) => editor.update("echo", (tool) => (tool.description = "Echo text")))
      yield* h.prompt("two")
      yield* h.prompt("three")
      for (const request of h.requests().slice(1)) expect(startOf(request)).toBe(startOf(h.requests()[0]))
      expect(yield* h.reminders()).toEqual([])
    }),
  )

  it.live("gives two changes before one step in one reminder", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.prompted("Be brief.")
      yield* h.tools((editor) => editor.add(extra()))
      yield* h.prompt("two")
      expect(startOf(h.requests()[1])).toBe(startOf(h.requests()[0]))
      expect(yield* h.reminders()).toEqual([
        [
          header,
          "The agent's prompt changed; from now on it is:\nBe brief.",
          "A new tool, extra, comes with this chat's next cold point (such as a compaction); until then it is in no list you have.",
        ].join("\n\n"),
      ])
    }),
  )

  it.live("keeps a tool removed meanwhile, whose call answers that it is unavailable", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.tools((editor) => editor.remove("echo"))
      yield* h.llm.push(TestLLM.toolCall("call-1", "echo", { text: "hi" }), TestLLM.text("done", "text-done"))
      yield* h.prompt("two")
      const requests = h.requests()
      expect(names(requests[1])).toContain("echo")
      expect(startOf(requests[2])).toBe(startOf(requests[0]))
      expect(JSON.stringify(requests[2]?.messages)).toContain('No tool named \\"echo\\" is currently available')
    }),
  )

  it.live("keeps a tool denied meanwhile, and denies its calls", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.session.setPermissions({
        sessionID: h.sessionID,
        permissions: [{ action: "echo", resource: "*", effect: "deny" }],
      })
      yield* h.llm.push(TestLLM.toolCall("call-1", "echo", { text: "hi" }), TestLLM.text("done", "text-done"))
      yield* h.prompt("two")
      const requests = h.requests()
      expect(startOf(requests[1])).toBe(startOf(requests[0]))
      expect(startOf(requests[2])).toBe(startOf(requests[0]))
      expect(JSON.stringify(requests[2]?.messages)).toContain("Permission denied: echo")
    }),
  )
})

describe("SessionPromptStart: the changes at the chat's next cold point", () => {
  it.live("after a compaction, with no reminder repeating them", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.prompted("Be brief.")
      yield* h.tools((editor) => editor.add(extra()))
      yield* h.prompt("two")
      yield* h.compact
      yield* h.prompt("three")
      yield* h.prompt("four")
      const requests = h.requests()
      const [three, four] = requests.slice(-2)
      expect(systemOf(three)).toBe("Be brief.")
      expect(names(three)).toEqual(["echo", "extra", "execute"])
      expect(startOf(four)).toBe(startOf(three))
      expect(yield* h.reminders()).toHaveLength(1)
      expect(texts(four).filter((text) => text.startsWith(header))).toEqual([])
    }),
  )

  it.live("after CLIProxyPacer reports the chat cold, and not while it reports it warm", () =>
    Effect.gen(function* () {
      const h = yield* setup({ model: cpp })
      yield* h.prompt("one")
      yield* h.prompted("Be brief.")
      // A view read after the step that says the cache is warm for another five minutes.
      yield* warmth.set({ sessionID: h.sessionID, warm: true, warmUntil: Date.now() + 300_000, asOf: Date.now() + 1 })
      yield* h.prompt("two")
      expect(startOf(h.requests()[1])).toBe(startOf(h.requests()[0]))
      yield* h.prompted("Be very brief.")
      yield* warmth.set({ sessionID: h.sessionID, warm: false, asOf: Date.now() + 1 })
      yield* h.prompt("three")
      expect(systemOf(h.requests()[2])).toBe("Be very brief.")
      // The cold step holds the change: only the warm one before it was told.
      expect(yield* h.reminders()).toHaveLength(1)
    }),
  )

  it.effect("after the provider's cache time without CLIProxyPacer", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.prompted("Be brief.")
      yield* TestClock.adjust("4 minutes")
      yield* h.prompt("two")
      expect(systemOf(h.requests()[1])).toBe(BASE)
      yield* h.prompted("Be very brief.")
      yield* TestClock.adjust("5 minutes")
      yield* h.prompt("three")
      expect(systemOf(h.requests()[2])).toBe("Be very brief.")
    }),
  )

  it.live("after a model switch", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.prompted("Be brief.")
      yield* h.prompt("two")
      expect(systemOf(h.requests()[1])).toBe(BASE)
      yield* h.session.switchModel({
        sessionID: h.sessionID,
        model: Model.Ref.make({ providerID: Provider.ID.make("fake"), id: Model.ID.make("other-model") }),
      })
      yield* h.prompt("three")
      expect(systemOf(h.requests()[2])).toBe("Be brief.")
      // The warm step was told; the switch's step holds the change and is told nothing.
      expect(yield* h.reminders()).toHaveLength(1)
    }),
  )

  it.live("after an agent switch", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.tools((editor) => editor.add(extra()))
      yield* h.prompt("two")
      expect(names(h.requests()[1])).toEqual(["echo", "execute"])
      yield* h.session.switchAgent({ sessionID: h.sessionID, agent: Agent.ID.make("plan") })
      yield* h.prompt("three")
      expect(systemOf(h.requests()[2])).toBe("You are the plan agent.")
      expect(names(h.requests()[2])).toEqual(["echo", "extra", "execute"])
      expect(yield* h.reminders()).toHaveLength(1)
    }),
  )

  it.live("in a new chat, which gets no reminder", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      const k = yield* setup()
      yield* k.prompted("Be brief.")
      yield* k.tools((editor) => editor.add(extra()))
      yield* k.prompt("one")
      expect(systemOf(k.requests()[0])).toBe("Be brief.")
      expect(names(k.requests()[0])).toEqual(["echo", "extra", "execute"])
      expect(yield* k.reminders()).toEqual([])
      // The chat that ran before the change is told of it at its next step.
      yield* h.prompt("two")
      expect(yield* h.reminders()).toHaveLength(1)
    }),
  )

  it.live("a subagent's chat keeps a start of its own", () =>
    Effect.gen(function* () {
      const lead = yield* setup()
      yield* lead.prompt("one")
      const child = yield* setup({ parent: lead.sessionID })
      yield* child.prompt("look")
      yield* lead.tools((editor) => editor.add(extra()))
      yield* child.prompt("look again")
      yield* lead.prompt("two")
      const childRequests = child.requests().filter((request) => systemOf(request) === "You explore.")
      expect(childRequests).toHaveLength(2)
      expect(startOf(childRequests[1])).toBe(startOf(childRequests[0]))
      expect(names(childRequests[0])).not.toContain("extra")
      expect(yield* child.reminders()).toHaveLength(1)
      expect(yield* lead.reminders()).toHaveLength(1)
    }),
  )
})

describe("SessionPromptStart's switch", () => {
  it.live("off by config: each step takes what is current, with no reminder; turned on, it keeps that start", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const off = new Document({ type: "document", info: new Info({ freeze_prompt: false }) })
      yield* config.setEntries([off])
      yield* h.prompt("one")
      yield* h.prompted("Be brief.")
      yield* h.prompt("two")
      expect(systemOf(h.requests()[1])).toBe("Be brief.")
      yield* config.setEntries([])
      yield* h.prompted("Be very brief.")
      yield* h.prompt("three")
      yield* h.prompted("Be terse.")
      yield* h.prompt("four")
      const requests = h.requests()
      expect(systemOf(requests[2])).toBe("Be very brief.")
      expect(startOf(requests[3])).toBe(startOf(requests[2]))
      expect(yield* h.reminders()).toHaveLength(1)
    }),
  )

  it.live("off by CLIProxyPacer's capabilities for a chat on it, whatever openforge's config says", () =>
    Effect.gen(function* () {
      const h = yield* setup({ model: cpp })
      yield* SubscriptionRef.set(catalogRef, catalogOf(false))
      yield* h.prompt("one")
      yield* h.prompted("Be brief.")
      yield* h.prompt("two")
      expect(systemOf(h.requests()[1])).toBe("Be brief.")
      expect(yield* h.reminders()).toEqual([])
      yield* SubscriptionRef.set(catalogRef, catalogOf(true))
      yield* h.prompt("three")
      yield* h.prompted("Be terse.")
      yield* h.prompt("four")
      expect(startOf(h.requests()[3])).toBe(startOf(h.requests()[2]))
    }),
  )
})

describe("SessionPromptStart's record", () => {
  it.live("survives a restart: a new instance sends the stored start, decoded from the database", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      const first = h.requests()[0]
      const instance = Effect.fnUntraced(function* () {
        const context = yield* Layer.build(
          SessionPromptStart.layer.pipe(
            Layer.provide(Layer.succeed(PacerWarmth.Service, warmth)),
            Layer.provide(catalogs),
          ),
        )
        return Context.get(context, SessionPromptStart.Service)
      })
      const restarted = yield* instance()
      const resolved = yield* restarted.resolve({
        kind: "primary",
        sessionID: h.sessionID,
        agent: Agent.ID.make("build"),
        model: { providerID: "fake", id: "fake-model" },
        system: "Something else.",
        definitions: Effect.succeed([]),
      })
      expect(resolved.system).toBe(BASE)
      expect(JSON.stringify(resolved.definitions)).toBe(JSON.stringify(first?.tools))
    }),
  )
})
