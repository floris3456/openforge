import { afterAll, describe, expect } from "bun:test"
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
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerTools } from "@opencode/core/pacer/tools"
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
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { Provider } from "@opencode/schema/provider"
import { Global } from "@opencode/util/global"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Effect, Layer, Schema, SubscriptionRef } from "effect"
import { testEffect } from "../lib/effect"
import { promptLocationNode } from "../fixture/prompt-location"
import { permissionLayer } from "../lib/permission"

// A chat on CLIProxyPacer reads its tool list before its instructions, so the text CPP writes for agents is in the
// chat's first request, part of the start recorded for it: an agent makes its first task in that request, and the task
// tool's rules live in that text. The read happens once (the request's own finds the list held), and a chat that already
// holds a list, or is on another provider, reads nothing.

const text = "CLIProxyPacer holds the person's memory and tasks; call its tools through execute."
/** What the fake's list holds: a tool CPP places in Code Mode, so the request looks for the list of a chat it serves. */
const moon = {
  name: "moon_phase",
  description: "Says the moon's phase.",
  input_schema: { type: "object", properties: {} },
}
const list = (instructions: { readonly text: string; readonly version: string } | undefined) => ({
  version: "7e570000000000aa",
  tools: { claude: [moon] },
  meta: { moon_phase: { title: "Moon phase", permission: "astronomy", subject: [], read_only: true, codemode: true } },
  ...(instructions === undefined ? {} : { instructions }),
})
/** What CPP writes for the plan agent, whose list read names it (`X-Pacer-Agent`). */
const planText = "CLIProxyPacer holds the person's memory; as plan, note what you decide."
const fake = {
  /** How many list reads the fake answered. */
  reads: 0,
  /** The agent each read named. */
  agents: [] as Array<string | null>,
  instructions: { text, version: "1" } as { readonly text: string; readonly version: string } | undefined,
}
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname !== "/pacer/v1/tools") return Response.json({ error: { type: "not_found" } }, { status: 404 })
    fake.reads++
    const agent = request.headers.get("x-pacer-agent")
    fake.agents.push(agent)
    return Response.json(list(agent === "plan" ? { text: planText, version: "2" } : fake.instructions))
  },
})
afterAll(() => server.stop(true))
const origin = `http://127.0.0.1:${server.port}`

const catalogRef = Effect.runSync(SubscriptionRef.make<PacerModels.Catalog | undefined>(undefined))
// The chat's endpoint is the fake before any layer is built, so its first read finds the server at once.
const endpointRef = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(undefined))
Effect.runSync(
  SubscriptionRef.set(endpointRef, PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: "key" }, undefined)),
)
const catalog = (webTools: boolean): PacerModels.Catalog => ({
  at: 0,
  pacer: { compactTokens: ["auto"], webTools },
  models: [],
})

const configs = Effect.runSync(Layer.build(Config.testLayer()).pipe(Effect.scoped))

class LLMRequests extends Context.Service<LLMRequests, LLMRequest[]>()("test/FirstStepRequests") {}
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
const echo = {
  name: "echo",
  description: "Echo text",
  options: { codemode: false },
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ text }: { text: string }) => Effect.succeed({ output: { text }, content: text }),
} satisfies Parameters<Tool.Editor["add"]>[0]
const echoNode = makeLocationNode({
  name: "test/first-step-tools",
  layer: Layer.effectDiscard(Tool.Service.use((registry) => registry.transform((editor) => editor.add(echo)))),
  deps: [Tool.node],
})
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
const replacements: LayerNode.Replacements = [
  Database.node.replace(Database.layer().pipe(Layer.provide(Global.layerWith({})))),
  Snapshot.node.replace(Snapshot.noopLayer),
  LayerNodePlatform.llmClient.replace(testLLM),
  SessionRunnerModel.node.replace(models),
  InstructionBuiltIns.node.replace(Layer.mock(InstructionBuiltIns.Service, none)),
  InstructionDiscovery.node.replace(
    Layer.mock(InstructionDiscovery.Service, { project: true, global: true, claude: false, ...none }),
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
    PacerTools.node,
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

const BASE = "You are the build agent."
const cppRef = Model.Ref.make({ providerID: Provider.ID.make("cliproxypacer"), id: Model.ID.make("claude-cpp") })

/** A chat on CLIProxyPacer with a list to read, and the model requests it made. */
const setup = Effect.fnUntraced(function* (input: { readonly model?: Model.Ref } = {}) {
  yield* SubscriptionRef.set(catalogRef, catalog(true))
  fake.reads = 0
  fake.agents = []
  fake.instructions = { text, version: "1" }
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
      agent.system = BASE
    })
    editor.update(Agent.ID.make("plan"), (agent) => {
      agent.mode = "primary"
      agent.system = "You are the plan agent."
    })
  })
  const project = Project.ID.make(crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"))
  yield* db
    .insert(ProjectTable)
    .values({ id: project, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const sessionID = Session.ID.make(`ses_first_${project.slice(0, 12)}`)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      ...(input.model ? { model: { id: input.model.id, providerID: input.model.providerID } } : {}),
      project_id: project,
      slug: sessionID,
      directory: "/project",
      title: "test",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const session = yield* Session.Service
  const pacerTools = yield* PacerTools.Service
  const requests = yield* LLMRequests
  const started = requests.length
  return {
    sessionID,
    session,
    pacerTools,
    /** The model requests of this test. */
    requests: () => requests.slice(started),
    prompt: (text: string) =>
      session.prompt({ sessionID, text, resume: false }).pipe(Effect.andThen(session.resume(sessionID))),
  }
})

const section = (request: LLMRequest | undefined) => request?.system.map((part) => part.text).join("\n\n") ?? ""
const said = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  )

describe("CLIProxyPacer's instructions in a chat's first step", () => {
  it.live("are in the first request's system prompt, after one list read", () =>
    Effect.gen(function* () {
      const h = yield* setup({ model: cppRef })
      yield* h.prompt("Make a task.")
      const [first] = h.requests()
      expect(section(first)).toContain(text)
      // The request's own read found the list held: one read for the step.
      expect(fake.reads).toBe(1)
    }),
  )

  it.live("are told as no change to the chat's second step, which reads nothing", () =>
    Effect.gen(function* () {
      const h = yield* setup({ model: cppRef })
      yield* h.prompt("Make a task.")
      yield* h.prompt("One more.")
      const [first, second] = h.requests()
      // The start holds it, so no step is told it again, as an update or otherwise.
      expect(said(second).join("\n")).not.toContain(text)
      expect(section(second)).toBe(section(first))
      expect(section(second)).toContain(text)
      expect(fake.reads).toBe(1)
    }),
  )

  it.live("come from a list read once more at the first step, a cold point, of a chat that held one before it", () =>
    Effect.gen(function* () {
      const h = yield* setup({ model: cppRef })
      // The chat as one whose list another request read before its first step: the step records the chat's start, so
      // it reads the list again (`PacerTools.cold`), once, before its instructions; its warm step after reads nothing.
      yield* h.pacerTools.list(
        PacerTools.listInput({
          session: { id: h.sessionID },
          model: "claude-cpp",
          agent: "build",
          codemode: true,
          step: true,
          continues: false,
        }),
      )
      expect(fake.reads).toBe(1)
      yield* h.prompt("Make a task.")
      expect(fake.reads).toBe(2)
      expect(section(h.requests()[0])).toContain(text)
      yield* h.prompt("One more.")
      expect(fake.reads).toBe(2)
    }),
  )

  it.live("leave a chat on another provider without the section", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.prompt("Make a task.")
      expect(section(h.requests()[0])).not.toContain("CLIProxyPacer")
      // The request's own read is all there is, as before: `SessionContext` reads nothing for another provider.
      expect(fake.reads).toBe(1)
    }),
  )

  it.live("are absent when the chat's list carries none", () =>
    Effect.gen(function* () {
      const h = yield* setup({ model: cppRef })
      fake.instructions = undefined
      yield* h.prompt("Make a task.")
      expect(section(h.requests()[0])).not.toContain("CLIProxyPacer")
      expect(fake.reads).toBe(1)
    }),
  )

  it.live("are the new agent's at the step after a switch of agent, whose list read names it", () =>
    Effect.gen(function* () {
      const h = yield* setup({ model: cppRef })
      yield* h.prompt("Make a task.")
      expect(section(h.requests()[0])).toContain(text)
      yield* h.session.switchAgent({ sessionID: h.sessionID, agent: Agent.ID.make("plan") })
      yield* h.prompt("Now plan it.")
      // The switch is a cold point: its step reads the list again, for plan, before its instructions are built.
      expect(fake.agents).toEqual(["build", "plan"])
      const switched = h.requests().at(-1)
      expect(section(switched)).toContain(planText)
      expect(section(switched)).not.toContain(text)
    }),
  )
})
