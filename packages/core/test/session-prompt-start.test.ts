import { describe, expect } from "bun:test"
import { AIError, HttpContext, LanguageModel, type LLMRequest, SystemPart } from "@opencode/ai/effect"
import { classifyProviderFailure } from "@opencode/ai/route"
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
import { IdentityPlugin } from "@opencode/core/plugin/identity"
import PROMPT_ANTHROPIC from "../src/plugin/system-prompt/anthropic.txt"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionPromptStart } from "@opencode/core/session/prompt-start"
import { PromptStartTable, PromptSystemTable, PromptToolsTable } from "@opencode/core/session/prompt-start.sql"
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
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Stream, SubscriptionRef } from "effect"
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

/** The model's compaction point, as CLIProxyPacer's capabilities give it; a test moves it between steps. */
const point: { compact?: number } = {}
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
          limit: { context: 200_000, output: 32_000, ...point },
        },
      ),
    ),
})
const none = { load: () => Effect.succeed(Instructions.empty) }
/** What the instruction sources give, which a test sets for itself and puts back. */
const sources: { discovery: Instructions.List; builtins: Instructions.List } = {
  discovery: Instructions.empty,
  builtins: Instructions.empty,
}
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
  InstructionBuiltIns.node.replace(
    Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.sync(() => sources.builtins) }),
  ),
  InstructionDiscovery.node.replace(
    Layer.mock(InstructionDiscovery.Service, {
      project: true,
      global: true,
      load: () => Effect.sync(() => sources.discovery),
    }),
  ),
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
  const hooks = yield* PluginHooks.Service
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
    /** A context hook, as a plugin of the running release registers one. */
    hook: (edit: (event: PluginHooks.Domains["session"]["context"]) => void) =>
      hooks.register("session", "context", (event) => Effect.sync(() => edit(event))),
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
      // A synthetic message, it reaches the model inside `<system-reminder>` (spec checkpoint, section 1).
      const sent = `<system-reminder>\n${reminders[0]}\n</system-reminder>`
      expect(texts(second)).toEqual(["one", "two", sent])
      expect(texts(third)).toEqual(["one", "two", sent, "three"])
    }),
  )

  // Workspace spec compaction-threshold-per-client, section 3: the point says when to compact, nothing a step sends.
  it.live("stays byte for byte when the model's compaction point moves, with no reminder", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      point.compact = 150_000
      yield* h.prompt("two")
      point.compact = 120_000
      yield* h.prompt("three")
      const [first, second, third] = h.requests()
      expect(startOf(second)).toBe(startOf(first))
      expect(startOf(third)).toBe(startOf(first))
      expect(second?.generation).toEqual(first?.generation)
      expect(third?.generation).toEqual(first?.generation)
      expect(texts(third)).toEqual(["one", "two", "three"])
      expect(yield* h.reminders()).toEqual([])
    }).pipe(Effect.ensuring(Effect.sync(() => delete point.compact))),
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
      yield* h.llm.push(TestLLM.text("Two.", "two"))
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
        system: [SystemPart.make("Something else.")],
        definitions: [],
      })
      expect(JSON.stringify(resolved.system)).toBe(JSON.stringify(first?.system))
      expect(JSON.stringify(resolved.definitions)).toBe(JSON.stringify(first?.tools))
    }),
  )
})

// 2026-11-16: only the agent's prompt and the definitions before the hooks were recorded, so whatever the running
// release's hooks and transforms put after them reached every warm chat at its next step (0.0.50's line in
// tool/plugin/opencode.ts missed every warm chat's cache). Each change here is one a release or a setting makes.
type ContextEvent = PluginHooks.Domains["session"]["context"]
const changes: ReadonlyArray<{
  readonly name: string
  readonly before: string
  readonly after: string
  readonly edit: (event: ContextEvent, value: string) => void
  /** What the reminder says of it. */
  readonly told: string
}> = [
  {
    name: "a part a context hook adds",
    before: "consider using `execute` to call `tools.opencode.session_move`",
    after: "consider using `execute` to call `tools.openforge.session_move`",
    edit: (event, value) => {
      event.system.push(SystemPart.make(value))
    },
    told: "of the system prompt changed",
  },
  {
    name: "the model's name in # Your Model",
    before: "Claude Opus 5",
    after: "Claude Opus 5.5",
    edit: (event, value) => {
      event.system.splice(1, 0, SystemPart.make(IdentityPlugin.identity({ name: value, ref: event.model })))
    },
    told: "Part 2 of the system prompt changed",
  },
  {
    name: "the prompt appended to the agent's for Claude (anthropic.txt)",
    before: PROMPT_ANTHROPIC,
    after: `${PROMPT_ANTHROPIC}\nOne more rule of the new release.`,
    edit: (event, value) => {
      const first = event.system[0]
      if (first) event.system[0] = { ...first, text: `${first.text}\n\n${value}` }
    },
    told: "The agent's prompt changed",
  },
  {
    name: "a tool a hook reshapes",
    before: "Echo text, in the shell bash",
    after: "Echo text, in the shell zsh",
    edit: (event, value) => {
      const tool = event.tools.echo
      if (tool) tool.description = value
    },
    told: "The tool echo changed",
  },
]
/** A text as it reads inside a request's JSON. */
const inJson = (text: string) => JSON.stringify(text).slice(1, -1)

describe("SessionPromptStart: the start as sent, after every transform and hook", () => {
  for (const change of changes)
    it.live(`stays byte for byte when ${change.name} changes, with one reminder; the next cold point holds it`, () =>
      Effect.gen(function* () {
        const h = yield* setup()
        const release = { value: change.before }
        yield* h.hook((event) => change.edit(event, release.value))
        yield* h.prompt("one")
        release.value = change.after
        yield* h.llm.push(TestLLM.text("Two.", "two"))
        yield* h.prompt("two")
        yield* h.prompt("three")
        const [one, two, three] = h.requests()
        expect(startOf(one)).toContain(inJson(change.before))
        expect(startOf(two)).toBe(startOf(one))
        expect(startOf(three)).toBe(startOf(one))
        const reminders = yield* h.reminders()
        expect(reminders).toHaveLength(1)
        expect(reminders[0]).toStartWith(header)
        expect(reminders[0]).toContain(change.told)
        yield* h.compact
        // The compaction sends the recorded start too, though its own hooks don't run this one.
        expect(startOf(h.requests()[3])).toBe(startOf(one))
        yield* h.prompt("four")
        yield* h.prompt("five")
        const [four, five] = h.requests().slice(-2)
        expect(startOf(four)).toContain(inJson(change.after))
        expect(startOf(four)).not.toBe(startOf(one))
        expect(startOf(five)).toBe(startOf(four))
        expect(yield* h.reminders()).toHaveLength(1)
      }),
    )

  it.live("gives a part a hook adds meanwhile, and one it no longer adds, in one reminder each", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const release = { parts: ["Rule A of the release."] }
      yield* h.hook((event) => {
        for (const text of release.parts) event.system.push(SystemPart.make(text))
      })
      yield* h.prompt("one")
      release.parts = ["Rule A of the release.", "Rule B of the release."]
      yield* h.prompt("two")
      release.parts = ["Rule B of the release."]
      yield* h.prompt("three")
      for (const request of h.requests().slice(1)) expect(startOf(request)).toBe(startOf(h.requests()[0]))
      const reminders = yield* h.reminders()
      expect(reminders).toHaveLength(2)
      expect(reminders[0]).toMatch(
        /Part \d of the system prompt is new, and applies from now on:\nRule B of the release\./,
      )
      expect(reminders[1]).toMatch(/Part \d of the system prompt no longer applies\. It was:\nRule A of the release\./)
    }),
  )

  it.live("stays when an instruction file changes, which its own reminder tells, as before", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const file = { text: "Use tabs." }
      sources.discovery = Instructions.make({
        key: Instructions.Key.make("project/agents.md"),
        codec: Schema.toCodecJson(Schema.String),
        read: Effect.sync(() => file.text),
        render: {
          initial: (text) => `Instructions from AGENTS.md:\n${text}`,
          changed: (_previous, text) => `Instructions from AGENTS.md are now:\n${text}`,
        },
      })
      yield* h.prompt("one")
      file.text = "Use spaces."
      yield* h.prompt("two")
      yield* h.prompt("three")
      const [one, two, three] = h.requests()
      expect(startOf(one)).toContain("Use tabs.")
      expect(startOf(two)).toBe(startOf(one))
      expect(startOf(three)).toBe(startOf(one))
      expect(JSON.stringify(two?.messages)).toContain("Instructions from AGENTS.md are now:\\nUse spaces.")
      expect(yield* h.reminders()).toEqual([])
    }).pipe(Effect.ensuring(Effect.sync(() => (sources.discovery = Instructions.empty)))),
  )

  it.effect("stays when the date changes, which its own reminder tells, as before", () =>
    Effect.gen(function* () {
      const builtins = Context.get(
        yield* Layer.build(
          AppNodeBuilder.build(InstructionBuiltIns.node, [
            Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
            Global.node.replace(Global.layerWith({})),
          ]),
        ),
        InstructionBuiltIns.Service,
      )
      sources.builtins = yield* builtins.load()
      // On CLIProxyPacer, whose view alone says a chat went cold: a day passes, and the chat is warm still.
      const h = yield* setup({ model: cpp })
      yield* h.prompt("one")
      yield* TestClock.adjust("1 day")
      yield* h.prompt("two")
      const [one, two] = h.requests()
      expect(startOf(one)).toContain("Today's date: Thu Jan 01 1970")
      expect(startOf(two)).toBe(startOf(one))
      expect(JSON.stringify(two?.messages)).toContain("Today's date is now: Fri Jan 02 1970")
      expect(yield* h.reminders()).toEqual([])
    }).pipe(Effect.ensuring(Effect.sync(() => (sources.builtins = Instructions.empty)))),
  )

  it.live("runs a tool's current implementation when its recorded definition differs", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("one")
      yield* h.tools((editor) =>
        editor.update("echo", (tool) => {
          tool.description = "Echo text, loudly"
          tool.execute = ({ text }) => Effect.succeed({ output: { text }, content: `${text.toUpperCase()}!` })
        }),
      )
      yield* h.llm.push(TestLLM.toolCall("call-1", "echo", { text: "hi" }), TestLLM.text("done", "text-done"))
      yield* h.prompt("two")
      const requests = h.requests()
      expect(startOf(requests[1])).toBe(startOf(requests[0]))
      expect(startOf(requests[2])).toBe(startOf(requests[0]))
      expect(JSON.stringify(requests[2]?.messages)).toContain("HI!")
    }),
  )
})

describe("SessionPromptStart: a cold point records the start as it is then, after every hook", () => {
  const coldPoints: ReadonlyArray<{
    readonly name: string
    readonly model?: Model.Ref
    readonly cool: (h: Effect.Success<ReturnType<typeof setup>>) => Effect.Effect<void, unknown>
  }> = [
    { name: "a compaction", cool: (h) => h.compact },
    {
      name: "a model switch",
      cool: (h) =>
        h.session
          .switchModel({
            sessionID: h.sessionID,
            model: Model.Ref.make({ providerID: Provider.ID.make("fake"), id: Model.ID.make("other-model") }),
          })
          .pipe(Effect.asVoid),
    },
    {
      name: "an agent switch",
      cool: (h) => h.session.switchAgent({ sessionID: h.sessionID, agent: Agent.ID.make("plan") }).pipe(Effect.asVoid),
    },
    {
      name: "CLIProxyPacer reporting the chat cold",
      model: cpp,
      cool: (h) => warmth.set({ sessionID: h.sessionID, warm: false, asOf: Date.now() + 1 }),
    },
  ]
  for (const point of coldPoints)
    it.live(`after ${point.name}`, () =>
      Effect.gen(function* () {
        const h = yield* setup(point.model ? { model: point.model } : {})
        const release = { line: "Line of release one." }
        yield* h.hook((event) => {
          event.system.push(SystemPart.make(release.line))
        })
        yield* h.prompt("one")
        release.line = "Line of release two."
        // An answer to compact.
        yield* h.llm.push(TestLLM.text("Two.", "two"))
        yield* h.prompt("two")
        expect(startOf(h.requests()[1])).toBe(startOf(h.requests()[0]))
        yield* point.cool(h)
        yield* h.prompt("three")
        const three = h.requests().at(-1)
        expect(three?.system.map((part) => part.text)).toContain("Line of release two.")
        expect(three?.system.map((part) => part.text)).not.toContain("Line of release one.")
        // Told once, at the warm step; the cold one holds the change.
        expect(yield* h.reminders()).toHaveLength(1)
      }),
    )

  it.live("in a new chat, with no reminder", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const release = { line: "Line of release one." }
      yield* h.hook((event) => {
        event.system.push(SystemPart.make(release.line))
      })
      yield* h.prompt("one")
      release.line = "Line of release two."
      const k = yield* setup()
      yield* k.prompt("one")
      expect(k.requests()[0]?.system.map((part) => part.text)).toContain("Line of release two.")
      expect(yield* k.reminders()).toEqual([])
    }),
  )

  for (const body of [
    {
      error: {
        code: "prompt_refused",
        message: "The provider refused this prompt.",
        type: "invalid_request_error",
      },
    },
    {
      error: {
        message: "Antigravity refused this request without using quota: RESOURCE_EXHAUSTED",
        type: "invalid_request_error",
      },
    },
  ])
    it.live(`after CLIProxyPacer answers that the provider refused the prompt (${body.error.message})`, () =>
      Effect.gen(function* () {
        const h = yield* setup({ model: cpp })
        const release = { line: "call `tools.opencode.session_move`" }
        yield* h.hook((event) => {
          event.system.push(SystemPart.make(release.line))
        })
        yield* h.prompt("one")
        release.line = "call `tools.openforge.session_move`"
        yield* h.llm.push(Stream.fail(refusal(body)))
        yield* h.prompt("two").pipe(Effect.ignore)
        yield* h.prompt("three")
        const [one, two, three] = h.requests()
        // The refused step still sent the recorded start; the next records the current one.
        expect(startOf(two)).toBe(startOf(one))
        expect(three?.system.map((part) => part.text)).toContain("call `tools.openforge.session_move`")
        expect(startOf(three)).not.toContain("tools.opencode.")
      }),
    )

  it.live("but not after another 400", () =>
    Effect.gen(function* () {
      const h = yield* setup({ model: cpp })
      const release = { line: "Line of release one." }
      yield* h.hook((event) => {
        event.system.push(SystemPart.make(release.line))
      })
      yield* h.prompt("one")
      release.line = "Line of release two."
      yield* h.llm.push(
        Stream.fail(refusal({ error: { message: "max_tokens is too large", type: "invalid_request_error" } })),
      )
      yield* h.prompt("two").pipe(Effect.ignore)
      yield* h.prompt("three")
      const [one, two, three] = h.requests()
      expect(startOf(two)).toBe(startOf(one))
      expect(startOf(three)).toBe(startOf(one))
    }),
  )
})

/** CPP's 400, as the route's executor turns it into a failure. */
function refusal(body: unknown) {
  const rawBody = JSON.stringify(body)
  return new AIError({
    reason: classifyProviderFailure({
      message: `HTTP 400: ${rawBody}`,
      status: 400,
      rawBody,
      http: new HttpContext({ url: "https://cpp.test/v1/chat/completions", status: 400, headers: {} }),
    }),
  })
}

describe("SessionPromptStart: a record from before the system parts", () => {
  // 0.0.50 recorded the agent's prompt and the definitions before the hooks, and sent
  // `[recorded system[0], ...current system[1..]]` through the current hooks with the recorded definitions. The release
  // that records the parts builds such a chat's first step the same way, so the upgrade misses nothing.
  it.live(
    "sends the start as 0.0.50 built it from the record, records it, and tells what differs in one reminder",
    () =>
      Effect.gen(function* () {
        const appended = "Rules a hook appends for Claude."
        const shape = (event: ContextEvent) => {
          const first = event.system[0]
          if (first) event.system[0] = { ...first, text: `${first.text}\n\n${appended}` }
          event.system.push(SystemPart.make("A line a hook adds."))
        }
        // Another chat's request gives the definitions as the registry has them now.
        const other = yield* setup()
        yield* other.prompt("one")
        const tools = (other.requests()[0]?.tools ?? []).map((tool) =>
          tool.type === "tool" && tool.name === "echo"
            ? { ...tool, description: "Echo text, as 0.0.50 recorded it" }
            : tool,
        )
        const h = yield* setup()
        yield* h.hook(shape)
        const old = "You are the build agent, as 0.0.50 recorded it."
        const { db } = yield* Database.Service
        yield* db
          .insert(PromptToolsTable)
          .values({ hash: `legacy-${h.sessionID}`, value: JSON.stringify(tools) })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(PromptStartTable)
          .values({
            session_id: h.sessionID,
            agent: "build",
            provider_id: "fake",
            model_id: "fake-model",
            system: old,
            tools: `legacy-${h.sessionID}`,
            told_system: old,
            told_tools: `legacy-${h.sessionID}`,
            compaction: null,
            time_created: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)
        yield* h.prompt("one")
        yield* h.prompt("two")
        const [one, two] = h.requests()
        // 0.0.50's path: the recorded prompt first, through the hooks; the parts after it as they are.
        expect(one?.system.map((part) => part.text)).toEqual([
          `${old}\n\n${appended}`,
          ...(other
            .requests()[0]
            ?.system.slice(1)
            .map((part) => part.text) ?? []),
          "A line a hook adds.",
        ])
        expect(one?.tools.find((tool) => tool.type === "tool" && tool.name === "echo")).toMatchObject({
          description: "Echo text, as 0.0.50 recorded it",
        })
        // Recorded as sent: the next step sends the same.
        expect(startOf(two)).toBe(startOf(one))
        const row = yield* db
          .select()
          .from(PromptStartTable)
          .where(eq(PromptStartTable.session_id, h.sessionID))
          .get()
          .pipe(Effect.orDie)
        expect(row?.parts).not.toBeNull()
        const reminders = yield* h.reminders()
        expect(reminders).toHaveLength(1)
        expect(reminders[0]).toContain("The agent's prompt changed")
        expect(reminders[0]).toContain("You are the build agent.")
        expect(reminders[0]).toContain(
          "The tool echo changed; its calls follow this from now on:\nDescription: Echo text\n",
        )
        expect(texts(one).at(-1)).toBe(`<system-reminder>\n${reminders[0]}\n</system-reminder>`)
      }),
  )
})

// 2026-11-16 (`run/evidence/cold-points/live-refused/`): the instructions part (Code Mode's catalog, skills, AGENTS.md
// and the other instruction files, the date, the environment) is rendered from the chat's instruction baseline, which
// only a completed compaction moved. Every other cold point recorded the old instructions again, so a chat the provider
// refused for a text in them was refused at every step.
describe("SessionPromptStart: a cold point takes the instructions as they are then", () => {
  /** An AGENTS.md as instruction discovery gives it, its text as the test sets it. */
  const agentsFile = (file: { text: string }) =>
    Instructions.make({
      key: Instructions.Key.make("project/agents.md"),
      codec: Schema.toCodecJson(Schema.String),
      read: Effect.sync(() => file.text),
      render: {
        initial: (text) => `Instructions from AGENTS.md:\n${text}`,
        changed: (_previous, text) => `Instructions from AGENTS.md are now:\n${text}`,
      },
    })
  const promptRefused = () =>
    Stream.fail(
      refusal({
        error: { code: "prompt_refused", message: "The provider refused this prompt.", type: "invalid_request_error" },
      }),
    )
  /** The system parts of the chat's record, as stored. */
  const recorded = Effect.fnUntraced(function* (sessionID: Session.ID) {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({ value: PromptSystemTable.value })
      .from(PromptStartTable)
      .innerJoin(PromptSystemTable, eq(PromptSystemTable.hash, PromptStartTable.parts))
      .where(eq(PromptStartTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    return row?.value ?? ""
  })
  /** The instruction updates a request carries after the history ("The instructions changed"). */
  const notices = (request: LLMRequest | undefined) =>
    (request?.messages ?? []).flatMap((message) =>
      message.role === "system" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
    )
  const reset = Effect.ensuring(Effect.sync(() => (sources.discovery = Instructions.empty)))

  it.live("after the provider refused the prompt for the instructions: the next step sends AGENTS.md as it is", () =>
    Effect.gen(function* () {
      const h = yield* setup({ model: cpp })
      const file = { text: "Marker: refuse-me-e8b3e6fc097c" }
      sources.discovery = agentsFile(file)
      yield* h.prompt("one")
      file.text = "No marker."
      yield* h.llm.push(promptRefused())
      yield* h.prompt("two").pipe(Effect.ignore)
      yield* h.prompt("three")
      const [one, two, three] = h.requests()
      expect(startOf(one)).toContain("refuse-me-e8b3e6fc097c")
      // The refused step sent the recorded start; the step after it is a cold point.
      expect(startOf(two)).toBe(startOf(one))
      expect(startOf(three)).not.toContain("refuse-me-e8b3e6fc097c")
      expect(startOf(three)).toContain(inJson("Instructions from AGENTS.md:\nNo marker."))
      expect(yield* recorded(h.sessionID)).toContain(inJson("Instructions from AGENTS.md:\nNo marker."))
      expect(yield* recorded(h.sessionID)).not.toContain("refuse-me-e8b3e6fc097c")
    }).pipe(reset),
  )

  const points: ReadonlyArray<{
    readonly name: string
    readonly model?: Model.Ref
    /** Whether the test moves the clock (`it.effect`) rather than running on the real one. */
    readonly clock?: boolean
    readonly cool: (h: Effect.Success<ReturnType<typeof setup>>) => Effect.Effect<void, unknown>
  }> = [
    {
      name: "the provider refused the prompt",
      model: cpp,
      cool: (h) => h.llm.push(promptRefused()).pipe(Effect.andThen(h.prompt("refused").pipe(Effect.ignore))),
    },
    {
      name: "a model switch",
      cool: (h) =>
        h.session
          .switchModel({
            sessionID: h.sessionID,
            model: Model.Ref.make({ providerID: Provider.ID.make("fake"), id: Model.ID.make("other-model") }),
          })
          .pipe(Effect.asVoid),
    },
    {
      name: "an agent switch",
      cool: (h) => h.session.switchAgent({ sessionID: h.sessionID, agent: Agent.ID.make("plan") }).pipe(Effect.asVoid),
    },
    {
      name: "the provider's cache time",
      clock: true,
      cool: () => TestClock.adjust("5 minutes"),
    },
    {
      name: "CLIProxyPacer reporting the chat cold",
      model: cpp,
      cool: (h) => warmth.set({ sessionID: h.sessionID, warm: false, asOf: Date.now() + 1 }),
    },
    { name: "a compaction", cool: (h) => h.compact },
  ]
  for (const point of points)
    (point.clock ? it.effect : it.live)(
      `after ${point.name}: the instructions as they are, recorded, sent unchanged after it; a later change is told`,
      () =>
        Effect.gen(function* () {
          const h = yield* setup(point.model ? { model: point.model } : {})
          const file = { text: "Marker: refuse-me-ed6fee50ca28" }
          sources.discovery = agentsFile(file)
          yield* h.prompt("one")
          file.text = "Told while warm."
          // An answer to compact.
          yield* h.llm.push(TestLLM.text("Two.", "two"))
          yield* h.prompt("two")
          const [one, two] = h.requests()
          expect(startOf(two)).toBe(startOf(one))
          expect(notices(two)).toContain("Instructions from AGENTS.md are now:\nTold while warm.")
          yield* point.cool(h)
          file.text = "Folded in at the cold point."
          yield* h.prompt("three")
          const three = h.requests().at(-1)
          expect(startOf(three)).not.toContain("refuse-me-ed6fee50ca28")
          expect(startOf(three)).toContain(inJson("Instructions from AGENTS.md:\nFolded in at the cold point."))
          // What the system part holds is told by no update.
          expect(notices(three).join("\n")).not.toContain("Folded in at the cold point.")
          const record = yield* recorded(h.sessionID)
          expect(record).toContain(inJson("Instructions from AGENTS.md:\nFolded in at the cold point."))
          yield* h.prompt("four")
          const four = h.requests().at(-1)
          expect(startOf(four)).toBe(startOf(three))
          expect(notices(four)).toEqual(notices(three))
          expect(yield* h.reminders()).toEqual([])
          file.text = "Changed after it."
          yield* h.prompt("five")
          const five = h.requests().at(-1)
          expect(startOf(five)).toBe(startOf(three))
          expect(notices(five)).toEqual([...notices(three), "Instructions from AGENTS.md are now:\nChanged after it."])
          expect(yield* recorded(h.sessionID)).toBe(record)
          expect(yield* h.reminders()).toEqual([])
        }).pipe(reset),
    )
})
