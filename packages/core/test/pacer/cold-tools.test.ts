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
import { PacerHttp } from "@opencode/core/pacer/http"
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
import { PromptStartTable, PromptToolsTable } from "@opencode/core/session/prompt-start.sql"
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
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, SubscriptionRef } from "effect"
import { testEffect } from "../lib/effect"
import { promptLocationNode } from "../fixture/prompt-location"
import { permissionLayer } from "../lib/permission"

// A chat's tool list follows its cold points: where its start is recorded anew (`SessionPromptStart.cold`), as after a
// compaction, its step reads the list again, so the start holds what CPP offers now; a warm step reads nothing and
// sends what was recorded. The owner's chat on the Mac (2026-11-19) lost the memory tools turned on for it: its
// compaction ended in its project's directory, while PacerTools, a global node, had been built under the person's
// home directory, the first to boot, and the bus hands such a node only that directory's events.

/** CPP's web search and memory's `remember`, as the chat's list defines them. */
const search = {
  name: "web_search",
  description: "CLIProxyPacer's web search, as the chat's list defines it.",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
}
const remember = {
  name: "remember",
  description: "CLIProxyPacer's remember, as the chat's list defines it once its project has memory.",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}
const meta = {
  web_search: { title: "Web search", permission: "websearch", subject: ["query"], read_only: true },
  remember: { title: "Remember", permission: "remember", subject: ["text"], read_only: false },
}
/** CPP's tools by name, as its capabilities name them. */
const cpp = new Set(Object.keys(meta))

/** CPP's list route: what it offers the chat now, and the reads it answered. */
const fake = { offer: [search] as ReadonlyArray<unknown>, reads: 0 }
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname !== "/pacer/v1/tools") return Response.json({ error: { type: "not_found" } }, { status: 404 })
    fake.reads++
    return Response.json({
      version: fake.offer.length === 1 ? "c01d000000000001" : "c01d000000000002",
      tools: { claude: fake.offer },
      meta,
    })
  },
})
afterAll(() => server.stop(true))

const endpointRef = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(undefined))
Effect.runSync(
  SubscriptionRef.set(
    endpointRef,
    PacerEndpoint.resolve({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "key" }, undefined),
  ),
)
const catalogRef = Effect.runSync(
  SubscriptionRef.make<PacerModels.Catalog | undefined>({
    at: 0,
    pacer: { compactTokens: ["auto"], webTools: true, tools: new Map(Object.entries(meta)) },
    models: [],
  }),
)
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

class LLMRequests extends Context.Service<LLMRequests, LLMRequest[]>()("test/ColdToolsRequests") {}
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
/** The registry's places for CPP's tools, which the chat's list fills or leaves out (`PacerOffer.apply`). */
const placeholder = (name: string) =>
  ({
    name,
    description: `A placeholder until the chat's list names ${name}.`,
    options: { codemode: false },
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }: { text: string }) => Effect.succeed({ output: { text }, content: text }),
  }) satisfies Parameters<Tool.Editor["add"]>[0]
const toolsNode = makeLocationNode({
  name: "test/cold-tools-placeholders",
  layer: Layer.effectDiscard(
    Tool.Service.use((registry) =>
      registry.transform((editor) => {
        for (const name of cpp) editor.add(placeholder(name))
      }),
    ),
  ),
  deps: [Tool.node],
})
const none = { load: () => Effect.succeed(Instructions.empty) }
const configs = Effect.runSync(Layer.build(Config.testLayer()).pipe(Effect.scoped))
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

/**
 * PacerTools as the service builds it: no root of the service asks for it, so the first directory to boot builds it,
 * with that directory's Location ambient. Here that is the person's home, and the chat is in `/project`.
 */
const home = AbsolutePath.make("/home/person")
const builtAtHome = makeGlobalNode({
  service: PacerTools.Service,
  layer: PacerTools.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Location.Service,
        Location.Service.of({
          directory: home,
          workspaceID: undefined,
          project: { id: Project.ID.global, directory: home, canonical: home },
        }),
      ),
    ),
  ),
  deps: [PacerEndpoint.node, PacerHttp.node, PacerModels.node, Bus.node, KV.node],
})

const harness = (extra: LayerNode.Replacements) => {
  const all = [...replacements, ...extra]
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
  ).pipe(Layer.provide(AppNodeBuilder.build(SessionRunnerLLM.node, all)), Layer.orDie)
  return testEffect(
    AppNodeBuilder.build(
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
        toolsNode,
        Config.node,
        Snapshot.node,
        SessionRunnerLLM.node,
        Session.node,
        PacerTools.node,
      ]),
      [
        ...all,
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
    ).pipe(Layer.provideMerge(testLLM)),
  )
}
const it = harness([])
const atHome = harness([PacerTools.node.replace(builtAtHome)])

const cppRef = Model.Ref.make({ providerID: Provider.ID.make("cliproxypacer"), id: Model.ID.make("claude-cpp") })

/** A chat on CLIProxyPacer in `/project`, CPP offering it the web search alone. */
const setup = Effect.fnUntraced(function* () {
  fake.offer = [search]
  fake.reads = 0
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
      agent.system = "You are the build agent."
    })
  })
  const project = Project.ID.make(crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"))
  yield* db
    .insert(ProjectTable)
    .values({ id: project, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const sessionID = Session.ID.make(`ses_cold_tools_${project.slice(0, 12)}`)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      model: { id: cppRef.id, providerID: cppRef.providerID },
      project_id: project,
      slug: sessionID,
      directory: "/project",
      title: "test",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const session = yield* Session.Service
  const llm = yield* TestLLM.Test
  const requests = yield* LLMRequests
  return {
    /** Sends a prompt and runs the chat: CPP's tools its one step's request offered, by name, sorted. */
    step: Effect.fnUntraced(function* (text: string) {
      const before = requests.length
      yield* llm.push(TestLLM.text("Done.", `answer-${before}`))
      yield* session.prompt({ sessionID, text, resume: false })
      yield* session.resume(sessionID)
      const sent = requests.slice(before)
      expect(sent).toHaveLength(1)
      return offered(sent[0])
    }),
    compact: Effect.gen(function* () {
      yield* llm.push(TestLLM.text("## Objective\n- summary", "summary"))
      yield* session.compact({ sessionID })
      yield* session.resume(sessionID)
    }),
    /** CPP's tools in the start recorded for the chat, by name, sorted. */
    recorded: Effect.gen(function* () {
      const start = yield* db
        .select({ tools: PromptStartTable.tools })
        .from(PromptStartTable)
        .where(eq(PromptStartTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const stored = yield* db
        .select({ value: PromptToolsTable.value })
        .from(PromptToolsTable)
        .where(eq(PromptToolsTable.hash, start?.tools ?? ""))
        .get()
        .pipe(Effect.orDie)
      return (JSON.parse(stored?.value ?? "[]") as Array<{ name: string }>)
        .map((tool) => tool.name)
        .filter((name) => cpp.has(name))
        .toSorted()
    }),
  }
})

const offered = (request: LLMRequest | undefined) =>
  (request?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name) => cpp.has(name))
    .toSorted()

/**
 * Two warm steps on the web search alone; then the chat's project gets memory, which CPP offers from the chat's next
 * cold point, and the chat compacts; then the step after it.
 */
const compacted = Effect.fnUntraced(function* () {
  const h = yield* setup()
  expect(yield* h.step("Look this up.")).toEqual(["web_search"])
  expect(yield* h.step("And this.")).toEqual(["web_search"])
  // The first step read the list; the warm one after it read nothing.
  expect(fake.reads).toBe(1)
  fake.offer = [search, remember]
  yield* h.compact
  // The compaction's own request carries the list the steps hold.
  expect(fake.reads).toBe(1)
  const after = yield* h.step("Remember that.")
  return { h, after }
})

describe("a chat's tool list at its cold points", () => {
  it.live("after a compaction, the next step reads the list once and records the tools CPP offers now", () =>
    Effect.gen(function* () {
      const { h, after } = yield* compacted()
      expect(fake.reads).toBe(2)
      expect(after).toEqual(["remember", "web_search"])
      expect(yield* h.recorded).toEqual(["remember", "web_search"])
    }),
  )

  it.live("a warm step after that reads nothing and sends what was recorded", () =>
    Effect.gen(function* () {
      const { h } = yield* compacted()
      expect(yield* h.step("And once more.")).toEqual(["remember", "web_search"])
      expect(fake.reads).toBe(2)
    }),
  )

  atHome.live(
    "reads it as well when PacerTools was built under another directory, whose bus hears none of the chat's compactions",
    () =>
      Effect.gen(function* () {
        const { h, after } = yield* compacted()
        expect(yield* h.recorded).toEqual(["remember", "web_search"])
        expect(after).toEqual(["remember", "web_search"])
        expect(fake.reads).toBe(2)
        expect(yield* h.step("And once more.")).toEqual(["remember", "web_search"])
        expect(fake.reads).toBe(2)
      }),
  )
})
