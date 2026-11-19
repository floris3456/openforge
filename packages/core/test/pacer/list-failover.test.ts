import { afterAll, describe, expect } from "bun:test"
import { OpenAICompatibleResponses } from "@opencode/ai/providers"
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
import { ServiceClient } from "@opencode/core/service-client"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { Provider } from "@opencode/schema/provider"
import { Global } from "@opencode/util/global"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Clock, DateTime, Duration, Effect, Fiber, Layer, Schema, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "../lib/effect"
import { promptLocationNode } from "../fixture/prompt-location"
import { permissionLayer } from "../lib/permission"
import { settle, until } from "./fake-tools"

// A step of a chat that holds no tool list (one not stepped since the service started) reads the list before its
// instructions (`SessionContext`) and again for its request (`SessionModelRequest`). While the address it is set up at
// is away, the read moves to the pair's other address and gets the list there at once; only when no address answers
// does the step wait for it, and then once, not again for its request.

// Synthetic: no real address or key.
const key = "k-list-failover"
/** CPP's own web search, as the chat's list defines it: it takes the place of the registry's placeholder. */
const search = {
  name: "web_search",
  description: "CLIProxyPacer's web search, as the chat's list defines it.",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
}
const meta = { title: "Web search", permission: "websearch", subject: ["query"], read_only: true }

/**
 * One instance of CPP's pair on a local server, recording each path it is asked for: its list, and a reply on
 * `/v1/responses`. `down` answers every request 502, as the tunnel does while the instance is away; `stop` makes it
 * refuse connections, as a stopped instance does.
 */
const instance = () => {
  const state = { mode: "up" as "up" | "down" | "stopped", paths: [] as string[], bodies: [] as string[] }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      state.paths.push(url.pathname)
      if (state.mode === "down") return new Response("bad gateway", { status: 502 })
      if (url.pathname === "/pacer/v1/tools")
        return Response.json({ version: "11a7000000000001", tools: { claude: [search] }, meta: { web_search: meta } })
      if (url.pathname !== "/v1/responses")
        return Response.json({ error: { type: "not_found", message: url.pathname } }, { status: 404 })
      state.bodies.push(await request.text())
      return new Response(
        [
          { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
          { type: "response.output_text.delta", item_id: "msg_1", delta: "Answered." },
          {
            type: "response.completed",
            response: { id: "resp_1", status: "completed", usage: { input_tokens: 400, output_tokens: 2 } },
          },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const root = `http://127.0.0.1:${server.port}`
  return {
    state,
    server,
    root,
    address: { ...PacerEndpoint.normalize(root)! },
    lists: () => state.paths.filter((path) => path === "/pacer/v1/tools").length,
    requests: () => state.paths.filter((path) => path === "/v1/responses").length,
    stop: () => {
      state.mode = "stopped"
      return Effect.promise(() => server.stop(true))
    },
  }
}
type Instance = ReturnType<typeof instance>
const instances = Array.from({ length: 4 }, instance)
afterAll(() => Promise.all(instances.map((item) => item.server.stop(true))))

/**
 * Where CPP is: the set-up address and its peer, as capabilities name them. An outage moves to the other one while it
 * is up, as `PacerEndpoint.failover` does once its `/healthz` answers.
 */
const pair = { instances: [] as Instance[], moves: 0 }
const home = () => PacerEndpoint.resolve({ baseURL: pair.instances[0]!.address.baseURL, apiKey: key }, undefined)!
const current = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(undefined))
const endpoints = PacerEndpoint.Service.of({
  get: () => SubscriptionRef.get(current),
  changes: () => SubscriptionRef.changes(current),
  addresses: () => Effect.sync(() => pair.instances.map((item) => item.address)),
  failover: (from) =>
    Effect.gen(function* () {
      const now = yield* SubscriptionRef.get(current)
      if (!now) return false
      if (from && !PacerEndpoint.same(from, now)) return true
      const next = pair.instances.find((item) => item.root !== now.root && item.state.mode === "up")
      if (!next) return false
      pair.moves++
      yield* SubscriptionRef.set(current, { ...home(), ...next.address, home: home().root })
      return true
    }),
})
// Capabilities name the web search, so a step looks for the chat's list.
const catalogRef = Effect.runSync(
  SubscriptionRef.make<PacerModels.Catalog | undefined>({
    at: 0,
    pacer: { compactTokens: [], webTools: true, tools: new Map([["web_search", meta]]) },
    models: [],
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

const cppRef = Model.Ref.make({ providerID: Provider.ID.make("cliproxypacer"), id: Model.ID.make("claude-cpp") })
/** The chat's model as the provider pins it: at the set-up address, which `PacerRoute` maps to where CPP is now. */
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.sync(() =>
      SessionRunnerModel.resolved(
        OpenAICompatibleResponses.configure({
          apiKey: key,
          baseURL: pair.instances[0]!.address.baseURL,
          provider: "cliproxypacer",
        }).model("claude-cpp"),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
        },
      ),
    ),
})
/** The registry's web search, which the chat's list replaces with CPP's own, and which goes without a list. */
const placeholder = {
  name: "web_search",
  description: "A placeholder until the chat's list names it.",
  options: { codemode: false },
  input: Schema.Struct({ query: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ query }: { query: string }) => Effect.succeed({ output: { text: query }, content: query }),
} satisfies Parameters<Tool.Editor["add"]>[0]
const toolsNode = makeLocationNode({
  name: "test/list-failover-tools",
  layer: Layer.effectDiscard(Tool.Service.use((registry) => registry.transform((editor) => editor.add(placeholder)))),
  deps: [Tool.node],
})

const none = { load: () => Effect.succeed(Instructions.empty) }
const configs = Effect.runSync(Layer.build(Config.testLayer()).pipe(Effect.scoped))
const replacements: LayerNode.Replacements = [
  Database.node.replace(Database.layer().pipe(Layer.provide(Global.layerWith({})))),
  Snapshot.node.replace(Snapshot.noopLayer),
  // The model client as the service runs it.
  LayerNodePlatform.llmClient.replace(ServiceClient.llm()),
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
  PacerEndpoint.node.replace(Layer.succeed(PacerEndpoint.Service, endpoints)),
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
const it = testEffect(
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
  ),
)

/**
 * A chat on CLIProxyPacer with an earlier exchange, set up at the first of `instances`, which this process has not
 * stepped: it holds no list. Its `step` sends one more prompt and runs the chat.
 */
const setup = Effect.fnUntraced(function* (name: string, instances: ReadonlyArray<Instance>) {
  pair.instances = [...instances]
  pair.moves = 0
  yield* SubscriptionRef.set(current, home())
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
  const sessionID = Session.ID.make(`ses_list_failover_${name}`)
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
  const messages = [
    SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Look this up.",
      time: { created: DateTime.makeUnsafe(0) },
    }),
    Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.ID.make("build"),
      model: cppRef,
      content: [{ type: "text", text: "Here is what I found." }],
      tokens: { input: 400, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, completed: 1 },
    }),
  ]
  yield* db
    .insert(SessionMessageTable)
    .values(
      messages.map((message, index) => {
        const { id: messageID, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
        return {
          id: SessionMessage.ID.make(messageID),
          session_id: sessionID,
          type,
          seq: index + 1,
          time_created: 0,
          data,
        }
      }),
    )
    .run()
    .pipe(Effect.orDie)
  yield* Bus.reserveSequence(db, sessionID, messages.length)
  const session = yield* Session.Service
  return {
    step: session
      .prompt({ sessionID, text: "Go on.", resume: false })
      .pipe(Effect.andThen(session.resume(sessionID)), Effect.forkChild({ startImmediately: true })),
  }
})

/** The tools a Responses request offered, by name. */
const offered = (body: string | undefined) =>
  new Map(
    ((JSON.parse(body ?? "{}").tools ?? []) as Array<{ name?: string; description?: string }>).map((tool) => [
      tool.name,
      tool.description,
    ]),
  )

describe("a step's tool list while the chat's address is away", () => {
  it.effect("is read at the pair's other address at once, and the step's request there carries CPP's tools", () =>
    Effect.gen(function* () {
      const [a, b] = [instances[0]!, instances[1]!]
      const h = yield* setup("moved", [a, b])
      yield* a.stop()
      const began = yield* Clock.currentTimeMillis
      const step = yield* h.step
      yield* until("the step's request at the other address", () => b.requests() === 1)
      yield* Fiber.join(step)
      // Nothing waited: no retry delay, no wait for the list.
      expect((yield* Clock.currentTimeMillis) - began).toBe(0)
      expect(pair.moves).toBe(1)
      expect(b.lists()).toBe(1)
      expect(offered(b.state.bodies[0]).get("web_search")).toBe(search.description)
    }),
  )

  it.effect("with no address answering, waits for the list once, not again for the step's request", () =>
    Effect.gen(function* () {
      const [c, d] = [instances[2]!, instances[3]!]
      c.state.mode = "down"
      d.state.mode = "down"
      const h = yield* setup("away", [c, d])
      const step = yield* h.step
      yield* until("the first list read", () => c.lists() === 1)
      // A second at a time, until the step's request goes out: one wait is PacerTools.WAIT, two would be twice it.
      let waited = 0
      while (c.requests() === 0 && waited < 3 * Duration.toSeconds(PacerTools.WAIT)) {
        yield* TestClock.adjust("1 second")
        yield* settle
        waited++
      }
      expect(c.requests()).toBe(1)
      expect(waited).toBeLessThan(1.5 * Duration.toSeconds(PacerTools.WAIT))
      // One wait's reads: at once, at +3 s, then every 5 s, the last at 58 s; the request's own read took its outcome.
      expect(c.lists()).toBeLessThanOrEqual(13)
      expect(pair.moves).toBe(0)
      expect(d.lists()).toBe(0)
      yield* Fiber.interrupt(step)
    }),
  )
})
