import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, describe, expect } from "bun:test"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Flag } from "@opencode/core/flag"
import { FSUtil } from "@opencode/util/fs-util"
import { Image } from "@opencode/core/image"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { MemoryClient } from "@opencode/core/memory/client"
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
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
import { SessionInstructions } from "@opencode/core/session/instructions"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Skill } from "@opencode/core/skill"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { promptLocationNode } from "../fixture/prompt-location"
import { initGit } from "../fixture/git"
import { testEffect } from "../lib/effect"
import { imagePassthrough } from "../lib/image"
import { permissionLayer } from "../lib/permission"
import { registerToolPlugin } from "../lib/tool"
import { catalogOf, codeModeList, endpointAt, key, pacerToolsNode, primeTools, startProxied } from "./fixture"

// Pictures in hand-ins (the workspace's spec `docs/specs/picture-hand-ins.md`, section 2), through the real runner: a
// helper that looked at a picture its work made since its task went active, and hands the task in without items, is
// refused before the call reaches the server. The real read tool reads real pictures in the chat's directory; the
// memory server is the small one, each test in a project of its own, its task tool a stand-in that ignores items.

const server = startProxied()
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hand-in-")))
// A git repository: only its chats have a project, and with it memory and the task tool.
await initGit(root)
afterAll(async () => {
  await server.stop()
  fs.rmSync(root, { recursive: true, force: true })
})
const reviewing = () => catalogOf(true, { prompt: false, plans: true, reviewItems: true })
/** A server whose steps take items and hold rounds of their own (section 5). */
const stepping = () => catalogOf(true, { prompt: false, plans: true, reviewItems: true, stepItems: true })
const configs = Effect.runSync(Layer.build(Config.testLayer()).pipe(Effect.scoped))

const endpointRef = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpointAt(server.origin)))
const catalogRef = Effect.runSync(SubscriptionRef.make<PacerModels.Catalog | undefined>(reviewing()))

const testLLM = TestLLM.testLayer({ fallback: TestLLM.text("Done.", "done") })
const model = LanguageModel.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
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
const readTool = makeLocationNode({
  name: "test/hand-in-read-tool",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    Tool.node,
    ReadToolFileSystem.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    InstructionDiscovery.node,
    Skill.node,
    FSUtil.node,
    Environment.node,
    Location.node,
    Config.node,
    Flag.node,
  ],
})
// CPP's tools as openforge registers them, the memory tools among them.
const memoryTools = pacerToolsNode("test/hand-in-pacer-tools")
const replacements: LayerNode.Replacements = [
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
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(root) })),
  Config.node.replace(Layer.succeedContext(configs)),
  Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
  Image.node.replace(imagePassthrough),
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
    Job.node,
    SessionProjector.node,
    SessionStore.node,
    Agent.node,
    Model.node,
    PluginHooks.node,
    Tool.node,
    readTool,
    memoryTools,
    PacerTools.node,
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

const by = { role: "build", chat: "ses_hand_in_maker" }
/** A real 1x1 PNG. */
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
)
/** How long before the test the chat began. */
const STARTED = 60_000

/**
 * A chat in a project of its own, a helper (a child of its lead) unless `lead`, inside its task, which went active
 * as the chat began, its first step of `steps` too: on that step, or on the task itself with `onTask` or no steps.
 * Both went active by its lead, unless the helper set them active itself, as `worker` says: the task and its first step
 * (`"task"`, a helper working through its own plan, the task's worker), or its step alone (`"step"`, a helper started on
 * a step of its lead's task).
 */
const setup = Effect.fnUntraced(function* (
  input: {
    readonly lead?: boolean
    readonly steps?: number
    readonly onTask?: boolean
    readonly worker?: "task" | "step"
    readonly catalog?: PacerModels.Catalog
    /** The server's `tools.task_codemode`: `task` runs in Code Mode, as its capabilities and its list say. */
    readonly codemode?: boolean
  } = {},
) {
  Effect.runSync(
    SubscriptionRef.set(
      catalogRef,
      input.codemode
        ? catalogOf(true, { prompt: false, plans: true, reviewItems: true, codemode: ["task"] })
        : (input.catalog ?? reviewing()),
    ),
  )
  server.reset()
  // The list's meta says it too, or a list read would learn `task` back as a direct tool.
  if (input.codemode) server.control.answer = codeModeList(server, ["task"])
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
    editor.update(Agent.ID.make("explore"), (agent) => {
      agent.mode = "subagent"
    })
  })
  const project = Project.ID.make(crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"))
  yield* db
    .insert(ProjectTable)
    .values({ id: project, worktree: AbsolutePath.make(root), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const lead = Session.ID.make(`ses_hand_in_${project.slice(0, 12)}`)
  const sessionID = input.lead ? lead : Session.ID.make(`${lead}_child`)
  const api = (route: string, body: unknown) =>
    Effect.promise(() =>
      fetch(`${server.store.url}/pacer/v1/memory/${project}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((answer) => answer.json() as Promise<{ task: { id: string } }>),
    ).pipe(Effect.map((answer) => answer.task.id))
  const make = (title: string, parent?: string) => api("/tasks", { title, ...(parent ? { parent } : {}), by })
  const change = (id: string, state: string, note?: string, who = by) =>
    api(`/tasks/${id}/state`, { state, ...(note === undefined ? {} : { note }), by: who })
  // The helper as CPP names it on its calls: openforge's session id as its chat.
  const helper = { role: "explore", chat: sessionID }
  const task = yield* make("Draw the counter")
  yield* change(task, "active", undefined, input.worker === "task" ? helper : by)
  const steps = yield* Effect.forEach(
    Array.from({ length: input.steps ?? 0 }, (_, n) => `Step ${n + 1}`),
    (title) => make(title, task),
  )
  if (steps[0]) yield* change(steps[0], "active", undefined, input.worker === undefined ? by : helper)
  const step = input.onTask ? undefined : steps[0]
  const inside = { task, ...(step ? { subtask: step } : {}) }
  // CPP keeps the chat's place; openforge's metadata says the same, as after the call that put it there.
  server.store.place(key, PacerSessionID.make(sessionID), { task, subtask: step ?? null })
  const began = Date.now() - STARTED
  const insert = (id: Session.ID, parent?: Session.ID) =>
    db
      .insert(SessionTable)
      .values({
        id,
        ...(parent ? { parent_id: parent, agent: Agent.ID.make("explore") } : {}),
        metadata: { memory: inside },
        project_id: project,
        slug: id,
        directory: root,
        title: "test",
        version: "test",
        time_created: began,
        time_updated: began,
      })
      .run()
      .pipe(Effect.orDie)
  yield* insert(lead)
  if (!input.lead) yield* insert(sessionID, lead)

  yield* primeTools(project)
  const session = yield* Session.Service
  const llm = yield* TestLLM.Test
  const read = (id: string) =>
    Effect.promise(() =>
      fetch(`${server.store.url}/pacer/v1/memory/${project}/tasks/${id}`, {
        headers: { authorization: `Bearer ${key}` },
      }).then((answer) => answer.json() as Promise<{ task: { state: string } }>),
    ).pipe(Effect.map((answer) => answer.task.state))
  return {
    project,
    sessionID,
    llm,
    task,
    steps,
    /** Task `id`'s state on the server. */
    state: read,
    /** Sets task `id`'s state on the server, with `note` if given, as another chat would. */
    change: (id: string, state: string, note?: string) => change(id, state, note).pipe(Effect.asVoid),
    prompt: (text: string) =>
      session.prompt({ sessionID, text, resume: false }).pipe(Effect.andThen(session.resume(sessionID))),
    /** The results of the chat's tool calls, by call. */
    results: () =>
      session.messages({ sessionID, order: "asc" }).pipe(
        Effect.map((messages) =>
          messages.flatMap((message) =>
            message.type === "assistant"
              ? message.content.flatMap((part) =>
                  part.type === "tool"
                    ? [
                        {
                          name: part.name,
                          status: part.state.status,
                          error: part.state.status === "error" ? part.state.error.message : undefined,
                        },
                      ]
                    : [],
                )
              : [],
          ),
        ),
      ),
    /** The chat's task tool calls that reached the server. */
    sent: () =>
      server.received.filter(
        (call) =>
          call.method === "POST" &&
          call.path === "/pacer/v1/tools/task" &&
          call.pacer["x-pacer-session"] === PacerSessionID.make(sessionID),
      ),
  }
})

/** A picture of the test's own in the chat's directory, changed `at` (ms since the epoch); its path as written. */
const picture = (name: string, at: number) => {
  const written = `${crypto.randomUUID().slice(0, 8)}-${name}`
  const target = path.join(root, written)
  fs.writeFileSync(target, png)
  fs.utimesSync(target, at / 1000, at / 1000)
  return written
}
/** A picture the work made: changed a moment after its task went active. */
const made = (name: string) => picture(name, Date.now() + 1_000)
/** A reference picture: changed an hour before its task went active. */
const older = (name: string) => picture(name, Date.now() - 3_600_000)

const ok = (name: string) => ({ name, status: "completed" as const, error: undefined })
const how = "each {picture, comment} saying what it shows and what to judge"
/** The refusal, and its way out (the owner, 2026-11-27: "Way out, lead always told"). */
const notSent = (kind: "task" | "step", id: string, pictures: string, ask: string) =>
  `Not sent: since ${kind} ${id} went active you looked at pictures changed after that: ${pictures}. Work that made pictures goes to review with them as items: ${ask} If none of them shows this ${kind}'s work (references you fetched, another task's pictures), send the same call again and it goes without them, its note telling your lead so.`
/** The refusal of a hand-in of the chat's task `task` itself. */
const onTask = (task: string, pictures: string) =>
  notSent("task", task, pictures, `send this again with items, those that show the work, ${how}.`)
/** The refusal of a hand-in on a step of the chat's task `task`: its items go on the task. */
const onTasksStep = (task: string, pictures: string) =>
  notSent(
    "task",
    task,
    pictures,
    `first give those that show the work as items on task ${task} (task with id ${task} and items, ${how}), then send this again.`,
  )
/** The refusal of `review` on the chat's step `step`. */
const onStep = (step: string, pictures: string) =>
  notSent("step", step, pictures, `send this again with items, those that show the work, ${how}.`)
/** The refusal of `done` on the chat's step `step`: it asks for review, so that the lead judges the step. */
const doneOnStep = (step: string, pictures: string) =>
  notSent("step", step, pictures, `send this again with state "review" and items, those that show the work, ${how}.`)
/** What a hand-in that went without its pictures adds to its note for its lead, naming them. */
const without = (pictures: ReadonlyArray<string>, named = pictures.join(", ")) =>
  pictures.length === 1
    ? `Handed in without its picture, a reference or another task's picture by the helper's word: ${named}.`
    : `Handed in without its ${pictures.length} pictures, references or another task's pictures by the helper's word: ${named}.`

describe("a helper's hand-in", () => {
  it.live("that looked at a picture its work made is refused without items, naming it, and goes with them", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "The counter is drawn." }),
        TestLLM.toolCall("call-items", "task", {
          id: h.task,
          state: "review",
          items: [{ picture: front, comment: "The counter from the front." }],
        }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onTask(h.task, front) },
        ok("task"),
      ])
      // The refused call never reached the server; the one with items did, and the task is in review.
      expect(h.sent()).toHaveLength(1)
      expect(h.sent()[0]!.body).toMatchObject({ id: h.task, state: "review" })
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("names every picture once, as written, in the order first looked at, at most 20 and how many more", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const pictures = Array.from({ length: 22 }, (_, n) => made(`view-${String(n + 1).padStart(2, "0")}.png`))
      yield* h.llm.push(
        ...pictures.map((written, n) => TestLLM.toolCall(`call-read-${n}`, "read", { path: written })),
        TestLLM.toolCall("call-again", "read", { path: pictures[0] }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "All views drawn." }),
        TestLLM.text("Refused.", "after"),
      )
      yield* h.prompt("draw every view")
      const results = yield* h.results()
      expect(results.at(-1)).toEqual({
        name: "task",
        status: "error",
        error: onTask(h.task, `${pictures.slice(0, 20).join(", ")} and 2 more`),
      })
      expect(h.sent()).toHaveLength(0)
    }),
  )

  it.live("that looked only at pictures older than its task's going active hands in with a note", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const reference = older("reference.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: reference }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "Compared, nothing to change." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("compare the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("that looked at no picture hands in with a note", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.llm.push(
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "The typo is fixed." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("fix the typo")
      expect(yield* h.results()).toEqual([ok("task")])
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("counts from its task's going active, when that came after the chat began", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      // Changed after the chat began and before its task went active, as in a round a deny sent back.
      const earlier = picture("earlier.png", Date.now() - STARTED / 2)
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: earlier }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "Nothing new to show." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("look again")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("that gave its task the pictures as items earlier hands in with a note", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-items", "task", { id: h.task, items: [{ picture: front, comment: "The front." }] }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "The counter is drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task"), ok("task")])
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("whose task a deny sent back to todo counts from then: its rework needs new pictures", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-items", "task", {
          id: h.task,
          state: "review",
          items: [{ picture: front, comment: "The counter from the front." }],
        }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      // The times are in milliseconds: the deny comes after the call with items.
      yield* Effect.sleep("10 millis")
      yield* h.change(h.task, "todo")
      const rework = made("rework.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read-rework", "read", { path: rework }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "Redrawn." }),
        TestLLM.text("Refused.", "after"),
      )
      yield* h.prompt("the front is too dark")
      expect(yield* h.results()).toEqual([
        ok("read"),
        ok("task"),
        ok("read"),
        { name: "task", status: "error", error: onTask(h.task, rework) },
      ])
      expect(yield* h.state(h.task)).toBe("todo")
    }),
  )

  // Section 5, item 5: a helper whose chat works on its task itself hands in as in section 2, its items on the task,
  // whose round is its hand-in, on a server whose steps take items or not.
  for (const on of [
    { server: "whose steps take items", catalog: stepping },
    { server: "whose steps take no items", catalog: reviewing },
  ])
    it.live(
      `review on a step of its task is refused, asking for items on the task first, and goes once it gave them, on a server ${on.server}`,
      () =>
        Effect.gen(function* () {
          const h = yield* setup({ steps: 2, onTask: true, catalog: on.catalog() })
          const step = h.steps[0]!
          const front = made("front.png")
          yield* h.llm.push(
            TestLLM.toolCall("call-read", "read", { path: front }),
            TestLLM.toolCall("call-review", "task", { id: step, state: "review", note: "Drawn." }),
            TestLLM.toolCall("call-items", "task", { id: h.task, items: [{ picture: front, comment: "The front." }] }),
            TestLLM.toolCall("call-review-again", "task", { id: step, state: "review", note: "Drawn." }),
            TestLLM.text("Handed in.", "after"),
          )
          yield* h.prompt("draw the counter")
          expect(yield* h.results()).toEqual([
            ok("read"),
            { name: "task", status: "error", error: onTasksStep(h.task, front) },
            ok("task"),
            ok("task"),
          ])
          // The items went on the task, then the step went to review.
          expect(h.sent().map((call) => call.body)).toMatchObject([{ id: h.task }, { id: step, state: "review" }])
          expect(yield* h.state(step)).toBe("review")
        }),
    )

  it.live("done on its task's last open step is refused the same way, and goes once it gave its task items", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, onTask: true, catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-done", "task", { id: step, state: "done", note: "Drawn." }),
        TestLLM.toolCall("call-items", "task", { id: h.task, items: [{ picture: front, comment: "The front." }] }),
        TestLLM.toolCall("call-done-again", "task", { id: step, state: "done", note: "Drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onTasksStep(h.task, front) },
        ok("task"),
        ok("task"),
      ])
      // The items went on the task, then its last step was done.
      expect(h.sent().map((call) => call.body)).toMatchObject([{ id: h.task }, { id: step, state: "done" }])
      expect(yield* h.state(step)).toBe("done")
    }),
  )

  it.live("done on a step of its task that is not the last goes: nothing goes to review", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 2, onTask: true, catalog: stepping() })
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-done", "task", { id: h.steps[0], state: "done", note: "Drawn." }),
        TestLLM.text("On to the next.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(h.steps[0]!)).toBe("done")
      expect(yield* h.state(h.task)).toBe("active")
    }),
  )

  it.live("on a server without review items goes as before: no items could be given", () =>
    Effect.gen(function* () {
      const h = yield* setup({ catalog: catalogOf(true, { prompt: false, plans: true }) })
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "The counter is drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("goes as before when the server cannot read its task", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const front = made("front.png")
      server.control.answer = (request) =>
        request.method === "GET" && request.path === `/pacer/v1/memory/${h.project}/tasks/${h.task}`
          ? Response.json({ error: { type: "internal", message: "down" } }, { status: 503 })
          : server.pass(request)
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "The counter is drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )
})

// Section 5, item 4: a helper that works on a step of its lead's task hands its pictures in on the step, where they
// open the step's own round, never on the task, whose open round may be its lead's.
describe("a helper's hand-in on its step", () => {
  it.live("that looked at a picture it made is refused without items, in its step's words, and goes with them", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 2, catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: step, state: "review", note: "The counter is drawn." }),
        TestLLM.toolCall("call-items", "task", {
          id: step,
          state: "review",
          items: [{ picture: front, comment: "The counter from the front." }],
        }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onStep(step, front) },
        ok("task"),
      ])
      // Only the call with items reached the server, on the step; the task was not touched.
      expect(h.sent().map((call) => call.body)).toMatchObject([{ id: step, state: "review" }])
      expect(yield* h.state(step)).toBe("review")
      expect(yield* h.state(h.task)).toBe("active")
    }),
  )

  for (const steps of [
    { count: 2, which: "a step before its task's last" },
    { count: 1, which: "its task's last open step" },
  ])
    it.live(`done on its step, ${steps.which}, is refused asking for review with items, and goes so`, () =>
      Effect.gen(function* () {
        const h = yield* setup({ steps: steps.count, catalog: stepping() })
        const step = h.steps[0]!
        const front = made("front.png")
        yield* h.llm.push(
          TestLLM.toolCall("call-read", "read", { path: front }),
          TestLLM.toolCall("call-done", "task", { id: step, state: "done", note: "Drawn." }),
          TestLLM.toolCall("call-review", "task", {
            id: step,
            state: "review",
            items: [{ picture: front, comment: "The front." }],
          }),
          TestLLM.text("Handed in.", "after"),
        )
        yield* h.prompt("draw the counter")
        expect(yield* h.results()).toEqual([
          ok("read"),
          { name: "task", status: "error", error: doneOnStep(step, front) },
          ok("task"),
        ])
        // The lead judges the step; its task was not touched.
        expect(h.sent().map((call) => call.body)).toMatchObject([{ id: step, state: "review" }])
        expect(yield* h.state(step)).toBe("review")
        expect(yield* h.state(h.task)).toBe("active")
      }),
    )

  it.live("whose step a deny sent back to todo counts from then: its rework needs new pictures", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-items", "task", {
          id: step,
          state: "review",
          items: [{ picture: front, comment: "The counter from the front." }],
        }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      // The times are in milliseconds: the deny comes after the call with items. Its worker is kept.
      yield* Effect.sleep("10 millis")
      yield* h.change(step, "todo")
      const rework = made("rework.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read-rework", "read", { path: rework }),
        TestLLM.toolCall("call-review", "task", { id: step, state: "review", note: "Redrawn." }),
        TestLLM.text("Refused.", "after"),
      )
      yield* h.prompt("the front is too dark")
      expect(yield* h.results()).toEqual([
        ok("read"),
        ok("task"),
        ok("read"),
        { name: "task", status: "error", error: onStep(step, rework) },
      ])
      expect(yield* h.state(step)).toBe("todo")
    }),
  )

  it.live("that gave its step the pictures as items earlier hands in with a note", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-items", "task", { id: step, items: [{ picture: front, comment: "The front." }] }),
        TestLLM.toolCall("call-review", "task", { id: step, state: "review", note: "The counter is drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task"), ok("task")])
      expect(yield* h.state(step)).toBe("review")
    }),
  )

  it.live("counts from its step's going active, not its task's", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, catalog: stepping() })
      const step = h.steps[0]!
      // Changed after the task went active and before its step went active again.
      yield* Effect.sleep("10 millis")
      const between = picture("between.png", Date.now())
      yield* Effect.sleep("10 millis")
      yield* h.change(step, "todo")
      yield* h.change(step, "active")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: between }),
        TestLLM.toolCall("call-review", "task", { id: step, state: "review", note: "Nothing new to show." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("look again")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(step)).toBe("review")
    }),
  )

  it.live("goes on another step and on its task: only its own step's hand-in is checked", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 2, catalog: stepping() })
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-other", "task", { id: h.steps[1], state: "review", note: "The other is drawn." }),
        TestLLM.toolCall("call-task", "task", { id: h.task, state: "review", note: "All drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task"), ok("task")])
      expect(h.sent()).toHaveLength(2)
      expect(yield* h.state(h.steps[1]!)).toBe("review")
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("goes on a server whose steps take no items: they could only go on the task", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1 })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: step, state: "review", note: "Drawn." }),
        // Its task's last open step: done sends the task to review.
        TestLLM.toolCall("call-done", "task", { id: step, state: "done", note: "Drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task"), ok("task")])
      expect(yield* h.state(step)).toBe("done")
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("goes as before when the server cannot read its step", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      server.control.answer = (request) =>
        request.method === "GET" && request.path === `/pacer/v1/memory/${h.project}/tasks/${step}`
          ? Response.json({ error: { type: "internal", message: "down" } }, { status: 503 })
          : server.pass(request)
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: step, state: "review", note: "The counter is drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(step)).toBe("review")
    }),
  )
})

// Section 5, item 5, as the lead decided on 2026-11-26: CPP places a helper working through its own plan on its current
// step, as it places one started on a step, so the place cannot tell them apart; the task's read can, by its worker. A
// helper that is its task's worker hands in on the task from any of its steps, and its items on a step go on the task
// (CPP since 3cd6b484); a helper started on a step of its lead's task is checked on that step.
describe("a helper on its own task, placed on its step", () => {
  it.live("that gave its task the pictures as items has its done on its last step go", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, worker: "task", catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-items", "task", { id: h.task, items: [{ picture: front, comment: "The front." }] }),
        TestLLM.toolCall("call-done", "task", { id: step, state: "done", note: "Drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task"), ok("task")])
      expect(h.sent().map((call) => call.body)).toMatchObject([{ id: h.task }, { id: step, state: "done" }])
      expect(yield* h.state(step)).toBe("done")
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("done on its last step without items is asked for items on its task first, and goes once it gave them", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, worker: "task", catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-done", "task", { id: step, state: "done", note: "Drawn." }),
        TestLLM.toolCall("call-items", "task", { id: h.task, items: [{ picture: front, comment: "The front." }] }),
        TestLLM.toolCall("call-done-again", "task", { id: step, state: "done", note: "Drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onTasksStep(h.task, front) },
        ok("task"),
        ok("task"),
      ])
      expect(h.sent().map((call) => call.body)).toMatchObject([{ id: h.task }, { id: step, state: "done" }])
      expect(yield* h.state(step)).toBe("done")
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("done on a step before its last goes: nothing goes to review", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 2, worker: "task", catalog: stepping() })
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-done", "task", { id: h.steps[0], state: "done", note: "Drawn." }),
        TestLLM.text("On to the next.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(h.steps[0]!)).toBe("done")
      expect(yield* h.state(h.steps[1]!)).toBe("active")
      expect(yield* h.state(h.task)).toBe("active")
    }),
  )

  it.live("whose items it gave on an earlier step, which CPP puts on its task, has its done on its last step go", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 2, worker: "task", catalog: stepping() })
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-items", "task", { id: h.steps[0], items: [{ picture: front, comment: "The front." }] }),
        // Done on the step it is on starts the next, and CPP places it there.
        TestLLM.toolCall("call-done", "task", { id: h.steps[0], state: "done", note: "Drawn." }),
        TestLLM.toolCall("call-done-last", "task", { id: h.steps[1], state: "done", note: "Checked." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task"), ok("task"), ok("task")])
      expect(yield* h.state(h.steps[1]!)).toBe("done")
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("review on its task without items is refused as its task's hand-in", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, worker: "task", catalog: stepping() })
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "The counter is drawn." }),
        TestLLM.text("Refused.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), { name: "task", status: "error", error: onTask(h.task, front) }])
      expect(h.sent()).toHaveLength(0)
    }),
  )

  it.live("on a server whose steps take no items is checked the same way: its items go on its task", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, worker: "task" })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-done", "task", { id: step, state: "done", note: "Drawn." }),
        TestLLM.text("Refused.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onTasksStep(h.task, front) },
      ])
      expect(h.sent()).toHaveLength(0)
    }),
  )

  it.live("a helper started on a step of its lead's task, which it set active, is checked on its step as before", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, worker: "step", catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-items", "task", { id: h.task, items: [{ picture: front, comment: "The front." }] }),
        TestLLM.toolCall("call-done", "task", { id: step, state: "done", note: "Drawn." }),
        TestLLM.toolCall("call-review", "task", {
          id: step,
          state: "review",
          items: [{ picture: front, comment: "The front." }],
        }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      // Its items on its lead's task do not count for its step.
      expect(yield* h.results()).toEqual([
        ok("read"),
        ok("task"),
        { name: "task", status: "error", error: doneOnStep(step, front) },
        ok("task"),
      ])
      expect(yield* h.state(step)).toBe("review")
      expect(yield* h.state(h.task)).toBe("active")
    }),
  )

  it.live("goes when the server cannot read its task: it cannot tell whose task it is", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, worker: "step", catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      server.control.answer = (request) =>
        request.method === "GET" && request.path === `/pacer/v1/memory/${h.project}/tasks/${h.task}`
          ? Response.json({ error: { type: "internal", message: "down" } }, { status: 503 })
          : server.pass(request)
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: step, state: "review", note: "The counter is drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(step)).toBe("review")
    }),
  )
})

// The moment is the newest change to active or todo that another chat made or that changed the state (the lead's rule
// of 2026-11-25): a note on an active task or step is kept as a change to the same state, and the chat's own notes
// must not restart it. A note is sent here with `state: "active"`, which the small server keeps as CLIProxyPacer
// keeps a note: a change to the same state, by the chat.
const places = [
  {
    on: "task",
    setup: () => setup(),
    own: (h: { readonly task: string }) => h.task,
    refused: onTask,
  },
  {
    on: "step",
    setup: () => setup({ steps: 1, catalog: stepping() }),
    own: (h: { readonly steps: ReadonlyArray<string> }) => h.steps[0]!,
    refused: onStep,
  },
]

describe("a helper's notes and the moment", () => {
  for (const place of places) {
    it.live(`a note of its own on its active ${place.on} does not restart it: the pictures before it count`, () =>
      Effect.gen(function* () {
        const h = yield* place.setup()
        const own = place.own(h)
        const front = made("front.png")
        yield* h.llm.push(
          TestLLM.toolCall("call-read", "read", { path: front }),
          TestLLM.toolCall("call-note", "task", {
            id: own,
            state: "active",
            note: "Rendered the front; the side next.",
          }),
          TestLLM.toolCall("call-review", "task", { id: own, state: "review", note: "The counter is drawn." }),
          TestLLM.text("Refused.", "after"),
        )
        yield* h.prompt("draw the counter")
        expect(yield* h.results()).toEqual([
          ok("read"),
          ok("task"),
          { name: "task", status: "error", error: place.refused(own, front) },
        ])
        // The note reached the server; the hand-in did not.
        expect(h.sent().map((call) => call.body)).toMatchObject([{ id: own, state: "active" }])
        expect(yield* h.state(own)).toBe("active")
      }),
    )

    it.live(
      `a note from another chat on its active ${place.on}, as a lead's new round, restarts it: the pictures before it do not count`,
      () =>
        Effect.gen(function* () {
          const h = yield* place.setup()
          const own = place.own(h)
          const front = made("front.png")
          yield* h.llm.push(
            TestLLM.toolCall("call-read", "read", { path: front }),
            TestLLM.text("Rendered the front.", "after"),
          )
          yield* h.prompt("draw the counter")
          // The times are in milliseconds: the lead's note comes after the chat's read.
          yield* Effect.sleep("10 millis")
          yield* h.change(own, "active", "Second round: draw the side too.")
          yield* h.llm.push(
            TestLLM.toolCall("call-review", "task", { id: own, state: "review", note: "The side needs nothing new." }),
            TestLLM.text("Handed in.", "after"),
          )
          yield* h.prompt("draw the side too")
          expect(yield* h.results()).toEqual([ok("read"), ok("task")])
          expect(yield* h.state(own)).toBe("review")
        }),
    )

    it.live(`its own move of its ${place.on} from todo to active after a deny restarts it`, () =>
      Effect.gen(function* () {
        const h = yield* place.setup()
        const own = place.own(h)
        const front = made("front.png")
        yield* h.llm.push(
          TestLLM.toolCall("call-read", "read", { path: front }),
          TestLLM.toolCall("call-items", "task", {
            id: own,
            state: "review",
            items: [{ picture: front, comment: "The counter from the front." }],
          }),
          TestLLM.text("Handed in.", "after"),
        )
        yield* h.prompt("draw the counter")
        // The times are in milliseconds: the deny, then a picture changed after it, then the chat takes the work up.
        yield* Effect.sleep("10 millis")
        yield* h.change(own, "todo", "The front is too dark.")
        yield* Effect.sleep("10 millis")
        const between = picture("between.png", Date.now())
        yield* Effect.sleep("10 millis")
        yield* h.llm.push(
          TestLLM.toolCall("call-active", "task", { id: own, state: "active" }),
          TestLLM.toolCall("call-read-between", "read", { path: between }),
          TestLLM.toolCall("call-review", "task", { id: own, state: "review", note: "Nothing new to show." }),
          TestLLM.text("Handed in.", "after"),
        )
        yield* h.prompt("the front is too dark")
        expect(yield* h.results()).toEqual([ok("read"), ok("task"), ok("task"), ok("read"), ok("task")])
        expect(yield* h.state(own)).toBe("review")
      }),
    )
  }
})

// The way out (the owner, 2026-11-27, option 1, "Way out, lead always told"): a helper whose pictures show none of its
// work (references it fetched, another task's pictures) sends the refused call again, and it goes without them, its
// note telling its lead so and naming them. Any other next call resets it.
describe("a helper's way out", () => {
  it.live(
    "refused, then the same call sent again goes without its pictures, its note telling its lead, naming them",
    () =>
      Effect.gen(function* () {
        const h = yield* setup()
        const first = made("street-1.jpg")
        const second = made("street-2.jpg")
        const note = "None of them is my work: they are the Street View references I fetched."
        yield* h.llm.push(
          TestLLM.toolCall("call-read-1", "read", { path: first }),
          TestLLM.toolCall("call-read-2", "read", { path: second }),
          TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "The corner is described." }),
          // The same task and state, no items: its note may differ.
          TestLLM.toolCall("call-again", "task", { id: h.task, state: "review", note }),
          TestLLM.text("Handed in.", "after"),
        )
        yield* h.prompt("describe the corner")
        expect(yield* h.results()).toEqual([
          ok("read"),
          ok("read"),
          { name: "task", status: "error", error: onTask(h.task, `${first}, ${second}`) },
          ok("task"),
        ])
        expect(h.sent().map((call) => call.body)).toEqual([
          { id: h.task, state: "review", note: `${note} ${without([first, second])}` },
        ])
        expect(yield* h.state(h.task)).toBe("review")
      }),
  )

  it.live("done on its step sent again goes done, its note, which it gave none, telling its lead", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, catalog: stepping() })
      const step = h.steps[0]!
      const other = made("other-task.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: other }),
        TestLLM.toolCall("call-done", "task", { id: step, state: "done" }),
        TestLLM.toolCall("call-again", "task", { id: step, state: "done" }),
        TestLLM.text("Done.", "after"),
      )
      yield* h.prompt("check the counter")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: doneOnStep(step, other) },
        ok("task"),
      ])
      expect(h.sent().map((call) => call.body)).toEqual([{ id: step, state: "done", note: without([other]) }])
      expect(yield* h.state(step)).toBe("done")
    }),
  )

  it.live("a call sent again with another state is refused again", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: step, state: "review", note: "Drawn." }),
        TestLLM.toolCall("call-done", "task", { id: step, state: "done", note: "Drawn." }),
        TestLLM.text("Refused.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onStep(step, front) },
        { name: "task", status: "error", error: doneOnStep(step, front) },
      ])
      expect(h.sent()).toHaveLength(0)
    }),
  )

  it.live("a call sent again on another task is refused again", () =>
    Effect.gen(function* () {
      const h = yield* setup({ steps: 1, worker: "task", catalog: stepping() })
      const step = h.steps[0]!
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-step", "task", { id: step, state: "review", note: "Drawn." }),
        TestLLM.toolCall("call-task", "task", { id: h.task, state: "review", note: "Drawn." }),
        TestLLM.text("Refused.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onTasksStep(h.task, front) },
        { name: "task", status: "error", error: onTask(h.task, front) },
      ])
      expect(h.sent()).toHaveLength(0)
    }),
  )

  it.live("the same call after another call between is refused again", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "Drawn." }),
        TestLLM.toolCall("call-look", "task", { id: h.task }),
        TestLLM.toolCall("call-again", "task", { id: h.task, state: "review", note: "Drawn." }),
        TestLLM.text("Refused.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onTask(h.task, front) },
        ok("task"),
        { name: "task", status: "error", error: onTask(h.task, front) },
      ])
      expect(h.sent().map((call) => call.body)).toEqual([{ id: h.task }])
    }),
  )

  it.live("after one way out, a later hand-in with new pictures is refused again", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const reference = made("reference.jpg")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: reference }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "Described." }),
        TestLLM.toolCall("call-again", "task", { id: h.task, state: "review", note: "Described." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("describe the corner")
      expect(yield* h.state(h.task)).toBe("review")
      // The times are in milliseconds: the deny comes after the hand-in.
      yield* Effect.sleep("10 millis")
      yield* h.change(h.task, "todo", "Draw it too.")
      const drawn = made("drawn.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read-drawn", "read", { path: drawn }),
        TestLLM.toolCall("call-review-drawn", "task", { id: h.task, state: "review", note: "Drawn." }),
        TestLLM.text("Refused.", "after"),
      )
      yield* h.prompt("draw it too")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onTask(h.task, reference) },
        ok("task"),
        ok("read"),
        { name: "task", status: "error", error: onTask(h.task, drawn) },
      ])
      expect(yield* h.state(h.task)).toBe("todo")
    }),
  )

  it.live("a call from a Code Mode script, refused, goes when the next script sends it again", () =>
    Effect.gen(function* () {
      const h = yield* setup({ codemode: true })
      const reference = made("reference.jpg")
      const script = `try { return await tools.task(${JSON.stringify({ id: h.task, state: "review", note: "Described." })}) } catch (error) { return String(error) }`
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: reference }),
        TestLLM.toolCall("call-exec", "execute", { code: script }),
        TestLLM.toolCall("call-exec-again", "execute", { code: script }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("describe the corner")
      expect(h.sent().map((call) => call.body)).toEqual([
        { id: h.task, state: "review", note: `Described. ${without([reference])}` },
      ])
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )

  it.live("names as many pictures as its note holds, and how many more", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const pictures = [1, 2, 3].map((n) => made(`${"street".repeat(25)}-${n}.jpg`))
      yield* h.llm.push(
        ...pictures.map((written, n) => TestLLM.toolCall(`call-read-${n}`, "read", { path: written })),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "Described." }),
        TestLLM.toolCall("call-again", "task", { id: h.task, state: "review", note: "Described." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("describe the corner")
      const note = `Described. ${without(pictures, `${pictures[0]}, ${pictures[1]} and 1 more`)}`
      expect(note.length).toBeLessThanOrEqual(500)
      expect(h.sent().map((call) => call.body)).toEqual([{ id: h.task, state: "review", note }])
    }),
  )

  it.live("a note too long to tell its lead too is refused with the length it may have, and a shorter one goes", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const front = made("front.png")
      const long = `${"The corner is described in full. ".repeat(14)}Done.`
      const words = without([front])
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: long }),
        TestLLM.toolCall("call-again", "task", { id: h.task, state: "review", note: long }),
        TestLLM.toolCall("call-shorter", "task", { id: h.task, state: "review", note: "Described." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("describe the corner")
      expect(yield* h.results()).toEqual([
        ok("read"),
        { name: "task", status: "error", error: onTask(h.task, front) },
        {
          name: "task",
          status: "error",
          error: `Not sent: with the words that tell your lead it goes without its pictures, your note would be ${long.length + 1 + words.length} characters, over the 500 a note may hold: send the same call again with a note of at most ${500 - 2 - words.length} characters.`,
        },
        ok("task"),
      ])
      expect(h.sent().map((call) => call.body)).toEqual([{ id: h.task, state: "review", note: `Described. ${words}` }])
    }),
  )
})

describe("a lead's hand-in", () => {
  it.live("is never refused, whatever pictures it looked at", () =>
    Effect.gen(function* () {
      const h = yield* setup({ lead: true })
      const front = made("front.png")
      yield* h.llm.push(
        TestLLM.toolCall("call-read", "read", { path: front }),
        TestLLM.toolCall("call-review", "task", { id: h.task, state: "review", note: "The counter is drawn." }),
        TestLLM.text("Handed in.", "after"),
      )
      yield* h.prompt("draw the counter")
      expect(yield* h.results()).toEqual([ok("read"), ok("task")])
      expect(yield* h.state(h.task)).toBe("review")
    }),
  )
})
