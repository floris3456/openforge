import { afterAll, describe, expect } from "bun:test"
import { LLMRequest } from "@opencode/ai/effect"
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
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { MemoryClient } from "@opencode/core/memory/client"
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
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Effect, Fiber, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { PacerHttp } from "@opencode/core/pacer/http"
import { testEffect } from "./lib/effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { permissionLayer } from "./lib/permission"
import { until } from "./pacer/fake-tools"
import { catalogOf, endpointAt, startProxied } from "./memory/fixture"

// The start block through the real runner: what each model request holds, over the small memory server. One server
// for the file; each test works in a project of its own.

const server = startProxied()
afterAll(() => server.stop())

/** What the memory side sees, in the test's hands: the endpoint and the catalog are read at each boundary. */
const pacer = {
  endpoint: endpointAt(server.origin) as PacerEndpoint.Endpoint | undefined,
  catalog: catalogOf(true) as PacerModels.Catalog | undefined,
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
    get: () => Effect.sync(() => pacer.endpoint),
    changes: () => Effect.die("unused") as never,
  }),
)
const catalogs = Layer.succeed(
  PacerModels.Service,
  PacerModels.Service.of({
    get: () => Effect.sync(() => pacer.catalog),
    changes: () => Effect.die("unused") as never,
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
        // Stands for memory's own tool (its plugin is not loaded here): the block names `recall` for a chat that has it.
        editor.add({
          name: "recall",
          description: "Finds entries in memory",
          options: { codemode: false },
          input: Schema.Struct({ query: Schema.String }),
          execute: () => Effect.succeed({ content: "Memory holds nothing for this." }),
        })
        // And for `remember`: a chat that has it is told that memory is its to keep true.
        editor.add({
          name: "remember",
          description: "Saves an entry in memory",
          options: { codemode: false },
          input: Schema.Struct({ text: Schema.String }),
          execute: () => Effect.succeed({ content: "Saved." }),
        })
      }),
    ),
  ),
  deps: [Tool.node],
})
const replacements: LayerNode.Replacements = [
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
  Permission.node.replace(permissionLayer()),
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
    Bus.node,
    SessionProjector.node,
    SessionStore.node,
    Agent.node,
    Model.node,
    PluginHooks.node,
    Tool.node,
    echo,
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
const setup = Effect.fnUntraced(function* (input: { readonly agent?: string; readonly child?: boolean } = {}) {
  pacer.endpoint = endpointAt(server.origin)
  pacer.catalog = catalogOf(true)
  server.reset()
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
  const memory = yield* Effect.provide(MemoryClient.Service, client)
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
  }
})

/** The texts of a request's user-role messages, in order: prompts and synthetic messages alike. */
const userTexts = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )
const day = (entry: MemoryClient.Entry) => new Date(entry.at).toISOString().slice(0, 10)
const opening =
  "Memory: what agents and people of this project noted earlier. It may be wrong or out of date; the code, the evidence and the person's words in this chat win over it."
const look =
  "; recall finds them: look there before a step this project may have its own way for (running, testing, releasing, deploying)."
const keep =
  "Keep it true as you work: replace an entry you find wrong or have now checked (remember with supersedes), and remember what a later chat will need that the project's files do not say: a fact you had to find out, a rule the person gives."

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
        `Memory holds 1 global entry and 1 of role build${look}`,
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
        // Nothing to find: the block does not say when to recall.
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

  it.live("waits for an unread catalog, and puts the block in at the next boundary once it says memory", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      pacer.catalog = undefined
      yield* h.llm.push(TestLLM.toolCall("call-1", "echo", { text: "one" }), TestLLM.text("done", "text-done"))
      const gate = yield* h.llm.gate()
      const run = yield* h.prompt("zebra?").pipe(Effect.forkChild({ startImmediately: true }))
      yield* gate.started
      pacer.catalog = catalogOf(true)
      yield* gate.release
      yield* Fiber.join(run)
      expect(userTexts(h.requests()[0])).toEqual(["zebra?"])
      expect(userTexts(h.requests()[1]).filter((text) => text.startsWith("Memory:"))).toHaveLength(1)
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
      expect(block).toEndWith(`Memory holds 0 global entries and 1 of role explore${look}\n${keep}`)
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
          `Memory holds 0 global entries and 1 of role viewer${look}`,
        ].join("\n"),
      )
    }),
  )
})
