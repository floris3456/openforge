import { describe, expect } from "bun:test"
import { type LanguageModel, ToolDefinition } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAICompatibleChat, OpenAICompatibleResponses } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/testing"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Context, DateTime, Effect, Fiber, Layer, SubscriptionRef } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { Message, SystemPart } from "@opencode/ai/effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerOffer } from "@opencode/core/pacer/offer"
import { PacerTools } from "@opencode/core/pacer/tools"
import { PacerWhere } from "@opencode/core/pacer/where"
import { PacerWarmth } from "@opencode/core/pacer/warmth"
import { Permission } from "@opencode/core/permission"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session as Sessions } from "@opencode/core/session"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionPromptStart } from "@opencode/core/session/prompt-start"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Tool } from "@opencode/core/tool"
import { PacerToolsPlugin } from "@opencode/core/tool/plugin/pacer-tools"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { location, locationNode } from "./fixture/location"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { codeModeListings, registerToolPlugin, toolIdentity } from "./lib/tool"
import { catalogOf, endpointOf, fakeCpp, ownerList, settle, startTools, until, webMeta } from "./pacer/fake-tools"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const parentID = Session.ID.make("ses_model_request_pacer_parent")
const session = Session.Info.make({
  id: Session.ID.make("ses_model_request_pacer"),
  parentID,
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
/**
 * A model of CPP's by its ID, or any provider's model. The provider goes through `route.with`: `route.model` keeps the
 * route's own provider (`anthropic`) whatever `provider` it is given.
 */
const resolved = (model: string | LanguageModel) =>
  SessionRunnerModel.resolved(
    typeof model === "string"
      ? AnthropicMessages.route.with({ provider: "cliproxypacer" }).model({ id: model })
      : model,
    {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      cost: [],
      limit: { context: 200_000, output: 32_000 },
    },
  )
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

// What the registry gives an agent that may use every tool: openforge's definitions sorted by name, the four
// placeholders among them.
const own = (name: string) =>
  new ToolDefinition({ name, description: `openforge's ${name}`, inputSchema: { type: "object" } })
const all = ["read", "web_crawl", "web_extract", "web_research", "web_search", "webfetch", "websearch"]
const snapshot = (
  names: ReadonlyArray<string>,
  executed: Array<ReadonlyMap<string, ToolDefinition> | undefined> = [],
) =>
  ({
    definitions: names.map(own),
    execute: (input) =>
      Effect.sync(() => {
        executed.push(input.definitions)
        return { content: [{ type: "text", text: "done" }] }
      }),
  }) satisfies Tool.Snapshot

/** The chat's project as PacerProject names it, for a location whose project has `remote`. */
const placedAt = (remote?: string) =>
  Layer.fresh(PacerProject.layer).pipe(
    Layer.provide(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location(Location.Ref.make({ directory: AbsolutePath.make("/home/floris/Café") }), { remote }),
        ),
      ),
    ),
    Layer.provide(Config.testLayer()),
  )

/** SessionModelRequest with PacerTools over a fake CPP; the chat `session`, in a location with `place`'s remote. */
const setup = Effect.fnUntraced(function* (
  webTools = true,
  options: {
    readonly session?: Session.Info
    readonly remote?: string
    readonly catalog?: PacerModels.Catalog
    /** What an earlier start kept of the endpoint's tools: the web tools by default; `{}` for none. */
    readonly known?: Readonly<Record<string, PacerTools.Meta>>
    /** Where chats work (`PacerWhere`); none by default. */
    readonly where?: PacerWhere.Interface
  } = {},
) {
  const cpp = yield* fakeCpp
  const started = yield* startTools(
    endpointOf(cpp.origin),
    options.catalog ?? catalogOf(webTools),
    undefined,
    options.known,
  )
  const requests = yield* SessionModelRequest.Service.pipe(
    Effect.provide(SessionModelRequest.layer),
    Effect.provideService(SessionModelTransport.Service, transport),
    Effect.provideService(PacerTools.Service, started.tools),
    Effect.provide(placedAt(options.remote)),
    (effect) => (options.where ? Effect.provideService(effect, PacerWhere.Service, options.where) : effect),
  )
  const input = (tools: Tool.Snapshot, model: string | LanguageModel = "claude-haiku-5-5") => ({
    session: options.session ?? session,
    agent: Agent.ID.make("build"),
    model: resolved(model),
    tools,
    system: [],
    messages: [],
  })
  // A model given by its ID is CPP's own.
  expect(String(input(snapshot([])).model.ref.providerID)).toBe("cliproxypacer")
  return { cpp, requests, input, catalogs: started.catalogs, started }
})

const busy = () => Response.json({ error: { type: "busy", message: "every store turn busy" } }, { status: 503 })
const names = (prepared: SessionModelRequest.Prepared<unknown>) => prepared.request.tools.map((tool) => tool.name)
/** CPP's tools in a request, in the shape CPP lists them. */
const claude = (prepared: SessionModelRequest.Prepared<unknown>) =>
  JSON.stringify(
    prepared.request.tools.flatMap((tool) =>
      tool.type === "tool" && tool.name.startsWith("web_")
        ? [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }]
        : [],
    ),
  )
const cppTools = (order: ReadonlyArray<string>) =>
  JSON.stringify(order.map((name) => ownerList.tools.claude.find((tool) => tool.name === name)))

describe("SessionModelRequest with CPP's web tools", () => {
  it.effect("puts CPP's definitions in a step's request as CPP wrote them, and hides upstream's websearch", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const prepared = yield* h.requests.primary(h.input(snapshot(all)))
      expect(names(prepared)).toEqual(["read", "web_crawl", "web_extract", "web_research", "web_search", "webfetch"])
      expect(claude(prepared)).toBe(cppTools(["web_crawl", "web_extract", "web_research", "web_search"]))
      // The list was read for this chat, under its parent, for its model.
      expect(h.cpp.lists().map((read) => [read.headers.get("x-pacer-session"), read.query.get("model")])).toEqual([
        [PacerSessionID.make(session.id), "claude-haiku-5-5"],
      ])
      expect(h.cpp.lists()[0]?.headers.get("x-pacer-parent-session")).toBe(PacerSessionID.make(parentID))

      // Anthropic Messages writes each as CPP's claude shape, byte for byte.
      const body = (yield* compileRequest(prepared.request)).body as { tools: Array<Record<string, unknown>> }
      const written = body.tools.flatMap(({ cache_control: _, ...tool }) =>
        String(tool.name).startsWith("web_") ? [tool] : [],
      )
      expect(JSON.stringify(written)).toBe(cppTools(["web_crawl", "web_extract", "web_research", "web_search"]))
    }),
  )

  it.effect("sends the same tools, byte for byte, on consecutive steps, reading the list once", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const first = yield* h.requests.primary(h.input(snapshot(all)))
      const second = yield* h.requests.primary(h.input(snapshot(all)))
      expect(JSON.stringify(second.request.tools)).toBe(JSON.stringify(first.request.tools))
      const compiled = yield* Effect.forEach([first, second], (prepared) => compileRequest(prepared.request))
      expect(JSON.stringify(compiled[1]?.body)).toBe(JSON.stringify(compiled[0]?.body))
      expect(h.cpp.lists()).toHaveLength(1)
    }),
  )

  it.effect("gives a compaction and a one-off generation the steps' list, also on another model", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const step = yield* h.requests.primary(h.input(snapshot(all)))
      const compaction = yield* h.requests.compaction(h.input(snapshot(all), "gpt-6-luna"))
      const generate = yield* h.requests.generate(h.input(snapshot(all)))
      expect(JSON.stringify(compaction.request.tools)).toBe(JSON.stringify(step.request.tools))
      expect(JSON.stringify(generate.request.tools)).toBe(JSON.stringify(step.request.tools))
      expect(h.cpp.lists()).toHaveLength(1)
    }),
  )

  it.effect("reads the list again at the step after a model answer's X-Pacer-Tools names another version", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const prepared = yield* h.requests.primary(h.input(snapshot(all)))
      const answer = (version: string) =>
        prepared.options.http!(HttpClientRequest.post("https://cpp.test/v1/messages"), (request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("{}", { headers: { "x-pacer-tools": version } })),
          ),
        )
      yield* answer(ownerList.version)
      yield* h.requests.primary(h.input(snapshot(all)))
      expect(h.cpp.lists()).toHaveLength(1)
      yield* answer("0123456789abcdef")
      yield* h.requests.compaction(h.input(snapshot(all)))
      expect(h.cpp.lists()).toHaveLength(1)
      yield* h.requests.primary(h.input(snapshot(all)))
      expect(h.cpp.lists()).toHaveLength(2)
    }),
  )

  it.effect("offers only what the agent may use: a denied websearch leaves out CPP's search and research", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const fetchOnly = all.filter((name) => !["web_search", "web_research", "websearch"].includes(name))
      const prepared = yield* h.requests.primary(h.input(snapshot(fetchOnly)))
      expect(names(prepared)).toEqual(["read", "web_crawl", "web_extract", "webfetch"])
      expect(claude(prepared)).toBe(cppTools(["web_crawl", "web_extract"]))
    }),
  )

  it.effect("keeps upstream's websearch and none of the four where CPP offers no list", () =>
    Effect.gen(function* () {
      const h = yield* setup(false)
      const prepared = yield* h.requests.primary(h.input(snapshot(all)))
      expect(names(prepared)).toEqual(["read", "webfetch", "websearch"])
      // Without the four registered (no CPP set up), nothing is read and nothing changes.
      const plain = yield* h.requests.primary(h.input(snapshot(["read", "webfetch", "websearch"])))
      expect(names(plain)).toEqual(["read", "webfetch", "websearch"])
      expect(h.cpp.lists()).toHaveLength(0)
    }),
  )

  it.effect("lets plugins' context hooks see and change CPP's tools, and runs a call by the tool's name", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          seen.push(...Object.keys(event.tools))
          event.tools.web_search!.description = "Search, as a plugin says."
          delete event.tools.web_crawl
        }),
      )
      const executed: Array<ReadonlyMap<string, ToolDefinition> | undefined> = []
      const prepared = yield* h.requests.primary(h.input(snapshot(all, executed)))
      expect(seen).toEqual(["read", "web_crawl", "web_extract", "web_research", "web_search", "webfetch"])
      expect(names(prepared)).toEqual(["read", "web_extract", "web_research", "web_search", "webfetch"])
      expect(prepared.request.tools.find((tool) => tool.name === "web_search")?.description).toBe(
        "Search, as a plugin says.",
      )

      yield* prepared.executeTool({
        sessionID: session.id,
        agent: Agent.ID.make("build"),
        messageID: "msg_model_request_pacer" as never,
        call: { type: "tool-call", id: "call_1", name: "web_search", input: { query: "q" } },
      })
      expect(executed[0]?.get("web_search")?.name).toBe("web_search")
      expect(executed[0]?.has("web_crawl")).toBe(false)
    }),
  )

  it.effect("gives a warm chat's first step after a restart its list, also after another chat's read failed", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const other = Session.Info.make({ ...session, id: Session.ID.make("ses_model_request_pacer_other") })
      h.cpp.answers.list = () =>
        Response.json({ error: { type: "busy", message: "every store turn busy" } }, { status: 503 })
      const failed = yield* h.requests.primary({ ...h.input(snapshot(all)), session: other })
      expect(names(failed)).toEqual(["read", "webfetch", "websearch"])

      // The service holds no chat's list after a restart: this chat's frozen copy is read, not left out.
      h.cpp.answers.list = () => Response.json(ownerList)
      const prepared = yield* h.requests.primary(h.input(snapshot(all)))
      expect(names(prepared)).toEqual(["read", "web_crawl", "web_extract", "web_research", "web_search", "webfetch"])
      expect(claude(prepared)).toBe(cppTools(["web_crawl", "web_extract", "web_research", "web_search"]))
      expect(h.cpp.lists().map((read) => read.headers.get("x-pacer-session"))).toEqual([
        PacerSessionID.make(other.id),
        PacerSessionID.make(session.id),
      ])
    }),
  )

  it.effect("waits for the list of a chat whose history holds a model answer; a new chat reads once", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const fresh = Session.Info.make({ ...session, id: Session.ID.make("ses_model_request_pacer_new") })
      h.cpp.answers.list = () => (h.cpp.lists().length < 3 ? busy() : Response.json(ownerList))
      const first = yield* h.requests.primary({
        ...h.input(snapshot(all)),
        session: fresh,
        messages: [Message.user("hello")],
      })
      expect(names(first)).toEqual(["read", "webfetch", "websearch"])
      expect(h.cpp.lists()).toHaveLength(1)

      const history = [Message.user("hello"), Message.assistant("hi"), Message.user("go on")]
      const waiting = yield* h.requests
        .compaction({ ...h.input(snapshot(all)), messages: history })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the chat's first read", () => h.cpp.lists().length === 2)
      yield* settle
      yield* TestClock.adjust("3 seconds")
      const prepared = yield* Fiber.join(waiting)
      expect(claude(prepared)).toBe(cppTools(["web_crawl", "web_extract", "web_research", "web_search"]))
      expect(h.cpp.lists().map((read) => read.headers.get("x-pacer-session"))).toEqual([
        PacerSessionID.make(fresh.id),
        PacerSessionID.make(session.id),
        PacerSessionID.make(session.id),
      ])
    }),
  )

  it.effect("a chat with steps and no list whose first read times out, as in a stalled process, sends its tools", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const history = [Message.user("hello"), Message.assistant("hi"), Message.user("go on")]
      h.cpp.hold()
      const waiting = yield* h.requests
        .primary({ ...h.input(snapshot(all)), messages: history })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the first read", () => h.cpp.lists().length === 1)
      // CPP answers at once, but openforge's 5 s pass first.
      yield* TestClock.adjust("5 seconds")
      yield* settle
      h.cpp.gate.release()
      yield* settle
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("3 seconds")
      const prepared = yield* Fiber.join(waiting)
      expect(names(prepared)).toEqual(["read", "web_crawl", "web_extract", "web_research", "web_search", "webfetch"])
      expect(claude(prepared)).toBe(cppTools(["web_crawl", "web_extract", "web_research", "web_search"]))
      expect(h.cpp.lists()).toHaveLength(2)
    }),
  )

  it.effect("follows the catalog: a CPP whose capabilities drop the web tools is offered none", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      expect(names(yield* h.requests.primary(h.input(snapshot(all))))).toContain("web_search")
      yield* SubscriptionRef.set(h.catalogs, catalogOf(false))
      expect(names(yield* h.requests.primary(h.input(snapshot(all))))).toEqual(["read", "webfetch", "websearch"])
    }),
  )
})

describe("SessionModelRequest on the first start after the upgrade, with nothing kept of CPP's tools", () => {
  /** The real registry over a store that keeps nothing yet, once it registered what it knows. */
  const first = Effect.fnUntraced(function* (catalog: PacerModels.Catalog) {
    const h = yield* setup(true, { catalog, known: {} })
    const registry = yield* registryOf(h.started)
    yield* settle
    return { ...h, registry }
  })

  it.effect("a new chat's first step offers the CPP tools its list holds and runs them", () =>
    Effect.gen(function* () {
      const h = yield* first(catalogOf(true, webMeta))
      const prepared = yield* h.requests.primary(h.input(yield* h.registry.snapshot()))
      expect(claude(prepared)).toBe(cppTools(web))
      expect(h.cpp.lists()).toHaveLength(1)
      const result = yield* prepared.executeTool({
        sessionID: session.id,
        ...toolIdentity,
        call: { type: "tool-call", id: "call_first", name: "web_search", input: { query: "q" } },
      })
      expect(result).toMatchObject({ content: [{ type: "text", text: "answered /pacer/v1/tools/web_search" }] })
    }),
  )

  it.effect("on a server whose capabilities lack pacer.tools, the first step goes without, as before", () =>
    Effect.gen(function* () {
      const h = yield* first(catalogOf(true))
      const prepared = yield* h.requests.primary(h.input(yield* h.registry.snapshot()))
      expect(claude(prepared)).toBe("[]")
      // The list it read registers them for the chat's later steps.
      yield* until("registered", () => Effect.runSync(h.registry.snapshot()).definitions.length > 1)
      const later = yield* h.requests.primary(h.input(yield* h.registry.snapshot()))
      expect(claude(later)).toBe(cppTools(web))
    }),
  )
})

describe("SessionModelRequest with CPP's web tools, for a chat whose start is recorded", () => {
  /** The requests over a database holding the chat, with the start of each chat recorded (`SessionPromptStart`). */
  const recorded = Effect.fnUntraced(function* () {
    const h = yield* setup()
    const base = yield* Layer.build(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node])))
    const db = Context.get(base, Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const store = (id: Session.ID) =>
      db
        .insert(SessionTable)
        .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: "t", version: "t" })
        .run()
        .pipe(Effect.orDie)
    yield* store(session.id)
    const starts = Context.get(
      yield* Layer.build(
        SessionPromptStart.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeedContext(base),
              PacerWarmth.layer,
              Layer.succeed(
                PacerModels.Service,
                PacerModels.Service.of({
                  get: () => SubscriptionRef.get(h.catalogs),
                  changes: () => SubscriptionRef.changes(h.catalogs),
                  refresh: () => Effect.void,
                }),
              ),
            ),
          ),
        ),
      ),
      SessionPromptStart.Service,
    )
    /** The requests over `tools`: another PacerTools is openforge started again over the same database. */
    const requestsWith = (tools: PacerTools.Interface) =>
      SessionModelRequest.Service.pipe(
        Effect.provide(SessionModelRequest.layer),
        Effect.provideService(SessionModelTransport.Service, transport),
        Effect.provideService(PacerTools.Service, tools),
        Effect.provideService(Database.Service, Context.get(base, Database.Service)),
        Effect.provideService(SessionPromptStart.Service, starts),
      )
    return { ...h, requests: yield* requestsWith(h.started.tools), requestsWith, store, starts }
  })

  it.effect(
    "a chat resumed right after the upgrade's restart has executors for its frozen tools on its first step",
    () =>
      Effect.gen(function* () {
        const h = yield* recorded()
        const history = [Message.user("hello"), Message.assistant("hi"), Message.user("go on")]
        const first = yield* h.requests.primary({ ...h.input(snapshot(all)), messages: history })
        expect(claude(first)).toBe(cppTools(web))

        // openforge started again with nothing kept of the endpoint's tools, as the first start of a release that
        // keeps them: the catalog's pacer.tools gives their executors before the chat's list is read.
        const again = yield* startTools(endpointOf(h.cpp.origin), catalogOf(true, webMeta), undefined, {})
        const registry = yield* registryOf(again)
        yield* until("registered", () => Effect.runSync(registry.snapshot()).definitions.length > 1)
        const requests = yield* h.requestsWith(again.tools)
        const resumed = yield* requests.primary({ ...h.input(yield* registry.snapshot()), messages: history })
        expect(JSON.stringify(resumed.request.tools)).toBe(JSON.stringify(first.request.tools))
        const result = yield* resumed.executeTool({
          sessionID: session.id,
          ...toolIdentity,
          call: { type: "tool-call", id: "call_resumed", name: "web_search", input: { query: "q" } },
        })
        expect(result).toMatchObject({ content: [{ type: "text", text: "answered /pacer/v1/tools/web_search" }] })
      }),
  )

  it.effect("keeps a warm chat's web tools byte for byte when CPP's catalog drops them; a new chat goes without", () =>
    Effect.gen(function* () {
      const h = yield* recorded()
      const first = yield* h.requests.primary(h.input(snapshot(all)))
      expect(claude(first)).toBe(cppTools(web))
      yield* SubscriptionRef.set(h.catalogs, catalogOf(false))
      const second = yield* h.requests.primary(h.input(snapshot(all)))
      expect(JSON.stringify(second.request.tools)).toBe(JSON.stringify(first.request.tools))
      // The reminder of the step says they are gone, after the history.
      const told = JSON.stringify(second.request.messages)
      for (const name of web) expect(told).toContain(`The tool ${name} is gone`)

      const other = Session.Info.make({ ...session, id: Session.ID.make("ses_model_request_pacer_later") })
      yield* h.store(other.id)
      const fresh = yield* h.requests.primary({ ...h.input(snapshot(all)), session: other })
      expect(names(fresh)).toEqual(["read", "webfetch", "websearch"])
    }),
  )
  // 2026-11-16: 0.0.50 changed the line tool/plugin/opencode.ts's context hook pushes after the agent's prompt
  // (`tools.opencode.session_move` became `tools.openforge.session_move`). Every warm chat's first step on 0.0.50 sent
  // the new line and missed CPP's cache (partial, prefix-changed, messages[0]) with its record kept: only the first
  // system part is frozen (model-request.ts, `system`), the hooks' parts are the running release's.
  it.effect("keeps a warm chat's system parts byte for byte when a context hook's part changes", () =>
    Effect.gen(function* () {
      const h = yield* recorded()
      const hooks = yield* PluginHooks.Service
      const release = { line: "call `tools.opencode.session_move`" }
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.system.push(SystemPart.make(release.line))
        }),
      )
      const step = (messages: ReadonlyArray<Message>) =>
        h.requests.primary({
          ...h.input(snapshot(all)),
          system: [SystemPart.make("The agent's prompt.")],
          start: "The agent's prompt.",
          messages: [...messages],
        })
      const first = yield* step([Message.user("hello")])
      expect(first.request.system.map((part) => part.text)).toEqual([
        "The agent's prompt.",
        "call `tools.opencode.session_move`",
      ])
      release.line = "call `tools.openforge.session_move`"
      const second = yield* step([Message.user("hello"), Message.assistant("hi"), Message.user("go on")])
      expect(JSON.stringify(second.request.system)).toBe(JSON.stringify(first.request.system))
    }),
  )
  // Web tools in Code Mode (workspace spec `docs/specs/web-tools-code-mode.md`): a chat warm at the upgrade, recorded
  // with the web tools direct as 0.0.44 records them, keeps its request's bytes and its web tools callable until its
  // next cold point, then has them in Code Mode. 0.0.43 shipped without this path tested, and running chats lost tools.
  it.effect(
    "a chat warm across the upgrade keeps its direct web tools until its next cold point, then has them in Code Mode",
    () =>
      Effect.gen(function* () {
        const h = yield* recorded()
        const registry = yield* registryOf(h.started)
        yield* until("registered", () => Effect.runSync(registry.snapshot()).definitions.length > 1)
        const history = [Message.user("hello"), Message.assistant("hi"), Message.user("search it")]
        const step = (requests: SessionModelRequest.Interface, tools: Tool.Snapshot, model = "claude-haiku-5-5") =>
          requests.primary({ ...h.input(tools, model), messages: history })
        const before = yield* step(h.requests, yield* registry.snapshot())
        expect(claude(before)).toBe(cppTools(web))

        // The upgrade: openforge starts again over the same store, and CPP's capabilities place the web tools in Code Mode.
        const placed = Object.fromEntries(
          Object.entries(webMeta).map(([name, meta]) => {
            const tool = ownerList.tools.claude.find((item) => item.name === name)!
            return [
              name,
              {
                ...meta,
                codemode: true,
                definition: {
                  description: tool.description,
                  input_schema: JSON.parse(JSON.stringify(tool.input_schema)),
                },
              },
            ]
          }),
        )
        // Its lists say so too, in each tool's meta.
        h.cpp.answers.list = () =>
          Response.json({
            ...ownerList,
            meta: Object.fromEntries(
              Object.entries(webMeta).map(([name, meta]) => [name, { ...meta, codemode: true }]),
            ),
          })
        const again = yield* startTools(endpointOf(h.cpp.origin), catalogOf(true, placed), h.started.kv)
        const upgraded = yield* registryOf(again)
        yield* until("in Code Mode", () => Effect.runSync(upgraded.snapshot()).definitions.length === 1)
        const now = yield* upgraded.snapshot()
        expect(now.definitions.map((tool) => tool.name)).toEqual(["execute"])
        const requests = yield* h.requestsWith(again.tools)

        // Warm: the same tools and body, byte for byte, no reminder that calls them gone, and they run as called.
        const warm = yield* step(requests, now)
        expect(JSON.stringify(warm.request.tools)).toBe(JSON.stringify(before.request.tools))
        const bodies = yield* Effect.forEach([before, warm], (prepared) => compileRequest(prepared.request))
        expect(JSON.stringify(bodies[1]?.body)).toBe(JSON.stringify(bodies[0]?.body))
        const direct = yield* warm.executeTool({
          sessionID: session.id,
          ...toolIdentity,
          call: { type: "tool-call", id: "call_warm", name: "web_search", input: { query: "q" } },
        })
        expect(direct).toMatchObject({ content: [{ type: "text", text: "answered /pacer/v1/tools/web_search" }] })
        // Its Code Mode catalog leaves them out while its record holds (`SessionContext`'s catalog follows it).
        const chat = { sessionID: session.id, agent: Agent.ID.make("build"), model: resolved("claude-haiku-5-5").ref }
        const held = yield* h.starts.recorded(chat)
        const moved = PacerOffer.codemode(yield* again.tools.known())
        const hidden = new Set((held ?? []).flatMap((tool) => (moved.has(tool.name) ? [tool.name] : [])))
        expect([...hidden].toSorted()).toEqual(web)
        expect(PacerOffer.catalog(now.codeModeCatalog!, hidden).tools.map((entry) => entry.name)).not.toContain(
          "web_search",
        )

        // Its next cold point (here a switch of its model): the web tools leave the direct list for Code Mode's catalog,
        // described as CPP describes them, and run there.
        const cold = yield* step(requests, now, "claude-opus-5-5")
        expect(names(cold)).toEqual(["execute"])
        expect(
          (yield* h.starts.recorded({ ...chat, model: resolved("claude-opus-5-5").ref }))?.map((tool) => tool.name),
        ).toEqual(["execute"])
        const listings = codeModeListings(now.codeModeCatalog!)
        for (const name of web) expect(listings.some((item) => item.path === name)).toBe(true)
        const search = ownerList.tools.claude.find((tool) => tool.name === "web_search")!.description.split("\n")[0]!
        expect(listings.find((item) => item.path === "web_search")?.line).toContain(search.slice(0, 40))
        const scripted = yield* cold.executeTool({
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call_cold",
            name: "execute",
            input: { code: 'return await tools.web_search({ query: "q" })' },
          },
        })
        expect(scripted).toMatchObject({ content: [{ type: "text", text: "answered /pacer/v1/tools/web_search" }] })
        expect(h.cpp.calls().map((call) => call.path)).toEqual([
          "/pacer/v1/tools/web_search",
          "/pacer/v1/tools/web_search",
        ])
      }),
  )
})

// A chat whose model is another provider's while a CPP is set up: the spec's "chats on any provider and model".
type Written = { readonly name: unknown; readonly type?: unknown; readonly schema: unknown }
/** A tool in any protocol's body or CPP's list shapes. */
type Item = {
  readonly name?: unknown
  readonly type?: unknown
  readonly input_schema?: unknown
  readonly parameters?: unknown
  readonly function?: { readonly name?: unknown; readonly parameters?: unknown }
}
const toolsOf = (body: unknown): ReadonlyArray<Item> => (body as { readonly tools?: ReadonlyArray<Item> }).tools ?? []
const acme = { provider: "acme", endpoint: { baseURL: "https://llm.acme.example/v1" } }
const others: ReadonlyArray<{
  readonly label: string
  /** The chat's provider, not CPP's. */
  readonly provider: string
  readonly id: string
  readonly model: LanguageModel
  /** Each tool of the compiled body in the protocol's own shape: its name, type and schema. */
  readonly written: (body: unknown) => ReadonlyArray<Written>
  /** CPP's list shape for this protocol, whose schemas are the same bytes as its `claude` shape's. */
  readonly shape: "claude" | "responses" | "chat"
}> = [
  {
    label: "anthropic on Messages",
    provider: "anthropic",
    id: "claude-sonnet-5",
    model: AnthropicMessages.route.with({ provider: "anthropic" }).model({ id: "claude-sonnet-5" }),
    written: (body) => toolsOf(body).map((tool) => ({ name: tool.name, schema: tool.input_schema })),
    shape: "claude",
  },
  {
    label: "a custom provider on openai-compatible Responses",
    provider: "acme",
    id: "acme-coder",
    model: OpenAICompatibleResponses.route.with(acme).model({ id: "acme-coder" }),
    written: (body) => toolsOf(body).map((tool) => ({ name: tool.name, type: tool.type, schema: tool.parameters })),
    shape: "responses",
  },
  {
    label: "a custom provider on openai-compatible Chat Completions",
    provider: "acme",
    id: "acme-chat",
    model: OpenAICompatibleChat.route.with(acme).model({ id: "acme-chat" }),
    written: (body) =>
      toolsOf(body).map((tool) => ({ name: tool.function?.name, type: tool.type, schema: tool.function?.parameters })),
    shape: "chat",
  },
]
const web = ["web_crawl", "web_extract", "web_research", "web_search"]
/** CPP's schema of a tool, as its list's bytes. */
const cppSchema = (name: string) =>
  JSON.stringify(ownerList.tools.claude.find((tool) => tool.name === name)?.input_schema)
/** The request headers of CPP's: `X-Pacer-*`. */
const pacerHeaders = (prepared: SessionModelRequest.Prepared<unknown>) =>
  Object.keys(prepared.request.headers ?? {}).filter((name) => /^x-pacer-/i.test(name))

/** The store's answer for the chat, a subagent: where the web tools' plugin reads a call's parent from. */
const sessions = Layer.mock(Sessions.Service, {
  get: () => Effect.succeed(session),
  revert: {
    stage: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
    commit: () => Effect.die("unused"),
  },
})
const pluginNode = makeLocationNode({
  name: "test/model-request-pacer-tools-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(PacerToolsPlugin.Plugin)),
  deps: [
    Tool.node,
    Permission.node,
    PacerTools.node,
    PacerProject.node,
    FileAccess.node,
    Environment.node,
    Sessions.node,
  ],
})
/** The real tool registry with CPP's web tools as built-in tools, over the setup's PacerTools; every ask allowed. */
const registryOf = Effect.fnUntraced(function* (started: Effect.Success<ReturnType<typeof startTools>>) {
  const context = yield* Layer.build(
    AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode]), [
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      PacerEndpoint.node.replace(
        Layer.succeed(
          PacerEndpoint.Service,
          PacerEndpoint.Service.of({
            get: () => SubscriptionRef.get(started.endpoints),
            changes: () => SubscriptionRef.changes(started.endpoints),
          }),
        ),
      ),
      PacerTools.node.replace(Layer.succeed(PacerTools.Service, started.tools)),
      Sessions.node.replace(sessions),
      Image.node.replace(imagePassthrough),
      locationNode("/project"),
    ]),
  )
  return Context.get(context, Tool.Service)
})

describe("SessionModelRequest for a chat on another provider, with a CPP set up", () => {
  it.effect("offers it CPP's definitions as CPP wrote them, in its protocol's shape, and no websearch", () =>
    Effect.gen(function* () {
      for (const other of others) {
        expect(String(resolved(other.model).ref.providerID)).toBe(other.provider)
        const h = yield* setup()
        const prepared = yield* h.requests.primary(h.input(snapshot(all), other.model))
        expect({ model: other.label, names: names(prepared) }).toEqual({
          model: other.label,
          names: ["read", "web_crawl", "web_extract", "web_research", "web_search", "webfetch"],
        })
        expect(claude(prepared)).toBe(cppTools(web))

        // The body the provider gets: each of CPP's tools with its schema as CPP's bytes, a function tool where the
        // protocol has types, and upstream's websearch nowhere.
        const body = (yield* compileRequest(prepared.request)).body
        const text = JSON.stringify(body)
        const written = other.written(body)
        expect({ model: other.label, names: written.map((tool) => tool.name) }).toEqual({
          model: other.label,
          names: ["read", "web_crawl", "web_extract", "web_research", "web_search", "webfetch"],
        })
        for (const name of web) {
          const tool = written.find((item) => item.name === name)
          expect({ model: other.label, name, schema: JSON.stringify(tool?.schema) }).toEqual({
            model: other.label,
            name,
            schema: cppSchema(name),
          })
          expect(text).toContain(cppSchema(name))
          if (other.shape !== "claude") expect(tool?.type).toBe("function")
        }
        // The same schemas as CPP's own shape for this protocol.
        const shaped: ReadonlyArray<Item> = ownerList.tools[other.shape]
        expect(
          shaped.map((tool) => JSON.stringify(tool.input_schema ?? tool.parameters ?? tool.function?.parameters)),
        ).toEqual(ownerList.tools.claude.map((tool) => cppSchema(tool.name)))
      }
    }),
  )

  it.effect("reads its list with the chat's X-Pacer-Session and parent, for its model, with CPP's key", () =>
    Effect.gen(function* () {
      for (const other of others) {
        expect(String(resolved(other.model).ref.providerID)).toBe(other.provider)
        const h = yield* setup()
        yield* h.requests.primary(h.input(snapshot(all), other.model))
        expect(
          h.cpp.lists().map((read) => ({
            model: read.query.get("model"),
            session: read.headers.get("x-pacer-session"),
            parent: read.headers.get("x-pacer-parent-session"),
            key: read.headers.get("authorization"),
          })),
        ).toEqual([
          {
            model: other.id,
            session: PacerSessionID.make(session.id),
            parent: PacerSessionID.make(parentID),
            key: "Bearer client-key-test",
          },
        ])
      }
    }),
  )

  it.effect("sends its model requests no X-Pacer-* header, whatever their kind, and upstream's own headers", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      for (const other of others) {
        expect(String(resolved(other.model).ref.providerID)).toBe(other.provider)
        const input = h.input(snapshot(all), other.model)
        const prepared = [
          yield* h.requests.primary(input),
          yield* h.requests.compaction(input),
          yield* h.requests.generate(input),
          yield* h.requests.title(input),
        ]
        expect({ model: other.label, pacer: prepared.map(pacerHeaders) }).toEqual({
          model: other.label,
          pacer: [[], [], [], []],
        })
        expect(prepared[0]?.request.headers).toMatchObject({
          "x-opencode-session-id": session.id,
          "x-opencode-parent-session-id": parentID,
        })
      }
      // The same chat on CPP's own provider gets them: what this test tells apart.
      expect(pacerHeaders(yield* h.requests.primary(h.input(snapshot(all))))).toEqual([
        "X-Pacer-Session",
        "X-Pacer-Parent-Session",
        "X-Pacer-Agent",
        "X-Pacer-Compact",
      ])
    }),
  )

  it.effect("runs its web_search through CPP with the chat's headers and CPP's key, by the registry's tool", () =>
    Effect.gen(function* () {
      for (const other of others) {
        expect(String(resolved(other.model).ref.providerID)).toBe(other.provider)
        const h = yield* setup()
        const registry = yield* registryOf(h.started)
        const prepared = yield* h.requests.primary(h.input(yield* registry.snapshot(), other.model))
        expect(claude(prepared)).toBe(cppTools(web))

        const result = yield* prepared.executeTool({
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call_other",
            name: "web_search",
            input: { query: "rust 1.95 release notes" },
          },
        })
        expect(result).toMatchObject({
          content: [{ type: "text", text: "answered /pacer/v1/tools/web_search" }],
          metadata: { provider: "Tavily" },
        })
        expect(
          h.cpp.calls().map((call) => ({
            model: other.label,
            path: call.path,
            body: call.body,
            session: call.headers.get("x-pacer-session"),
            parent: call.headers.get("x-pacer-parent-session"),
            key: call.headers.get("authorization"),
          })),
        ).toEqual([
          {
            model: other.label,
            path: "/pacer/v1/tools/web_search",
            body: JSON.stringify({ query: "rust 1.95 release notes" }),
            session: PacerSessionID.make(session.id),
            parent: PacerSessionID.make(parentID),
            key: "Bearer client-key-test",
          },
        ])
      }
    }),
  )
})

describe("SessionModelRequest naming the chat's project to CPP", () => {
  const identity = Project.ID.make("4b825dc642cb6eb9a060e54bf8d69288fbee4904")
  const lead = Session.Info.make({
    ...session,
    id: Session.ID.make("ses_model_request_project"),
    parentID: undefined,
    projectID: identity,
  })
  const child = Session.Info.make({ ...session, projectID: identity })
  const named = {
    "X-Pacer-Project": identity,
    "X-Pacer-Project-Name": "github.com%2Fowner%2Fcaf%C3%A9",
    "X-Pacer-Project-Remote": "github.com%2Fowner%2Fcaf%C3%A9",
  }
  const project = (headers: Readonly<Record<string, string>> | undefined) =>
    Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => /^x-pacer-project/i.test(name)))
  const read = (cpp: Effect.Success<typeof fakeCpp>) =>
    cpp.lists().map((list) => project(Object.fromEntries(list.headers)))

  it.effect(
    "on a turn, a title, a generation and a compaction, and on the chat's tool list read; a subagent's too",
    () =>
      Effect.gen(function* () {
        for (const chat of [lead, child]) {
          const h = yield* setup(true, { session: chat, remote: "github.com/owner/café" })
          const input = h.input(snapshot(all))
          const prepared = [
            yield* h.requests.primary(input),
            yield* h.requests.title(input),
            yield* h.requests.generate(input),
            yield* h.requests.compaction(input),
          ]
          expect(prepared.map((item) => project(item.request.headers))).toEqual([named, named, named, named])
          expect(prepared[0]?.request.headers).toMatchObject({
            "X-Pacer-Session": PacerSessionID.make(chat.id),
            ...(chat.parentID ? { "X-Pacer-Parent-Session": PacerSessionID.make(chat.parentID) } : {}),
          })
          expect(read(h.cpp)).toEqual([
            {
              "x-pacer-project": identity,
              "x-pacer-project-name": named["X-Pacer-Project-Name"],
              "x-pacer-project-remote": named["X-Pacer-Project-Remote"],
            },
          ])
        }
      }),
  )

  it.effect("names the chat's agent on each kind of model request and on its tool list read", () =>
    Effect.gen(function* () {
      const h = yield* setup(true, { session: child })
      const input = { ...h.input(snapshot(all)), agent: Agent.ID.make("explore") }
      const prepared = [
        yield* h.requests.primary(input),
        yield* h.requests.title(input),
        yield* h.requests.generate(input),
        yield* h.requests.compaction(input),
      ]
      expect(prepared.map((item) => item.request.headers?.["X-Pacer-Agent"])).toEqual([
        "explore",
        "explore",
        "explore",
        "explore",
      ])
      expect(h.cpp.lists().map((list) => list.headers.get("x-pacer-agent"))).toEqual(["explore"])
    }),
  )

  it.effect("names the folder without a remote, and no project for a chat outside any", () =>
    Effect.gen(function* () {
      const h = yield* setup(true, { session: lead })
      expect(project((yield* h.requests.primary(h.input(snapshot(all)))).request.headers)).toEqual({
        "X-Pacer-Project": identity,
        "X-Pacer-Project-Name": "Caf%C3%A9",
      })

      const k = yield* setup(true, { remote: "github.com/owner/café" })
      expect(session.projectID).toBe(Project.ID.global)
      const prepared = yield* k.requests.primary(k.input(snapshot(all)))
      expect(pacerHeaders(prepared)).toEqual([
        "X-Pacer-Session",
        "X-Pacer-Parent-Session",
        "X-Pacer-Agent",
        "X-Pacer-Compact",
      ])
      expect(read(k.cpp)).toEqual([{}])
    }),
  )

  it.effect("sends a plain provider's model requests none, and CPP's tool list read for them its own", () =>
    Effect.gen(function* () {
      for (const other of others) {
        const h = yield* setup(true, { session: child, remote: "github.com/owner/café" })
        const input = h.input(snapshot(all), other.model)
        for (const prepared of [
          yield* h.requests.primary(input),
          yield* h.requests.title(input),
          yield* h.requests.compaction(input),
        ])
          expect({ model: other.label, pacer: pacerHeaders(prepared) }).toEqual({ model: other.label, pacer: [] })
        expect(read(h.cpp)).toHaveLength(1)
        expect(read(h.cpp)[0]).toMatchObject({ "x-pacer-project": identity })
      }
    }),
  )
})

describe("SessionModelRequest saying where the chat works", () => {
  const asked: string[] = []
  const where = PacerWhere.Service.of({
    folder: (directory) => Effect.sync(() => (asked.push(directory), "~/repos/openforge@adj-of")),
    chat: () => Effect.die("unused"),
  })

  it.effect(
    "on a turn, a title, a generation and a compaction to CPP, from the chat's folder; none to another provider",
    () =>
      Effect.gen(function* () {
        asked.length = 0
        const h = yield* setup(true, { where })
        const input = h.input(snapshot(all))
        const prepared = [
          yield* h.requests.primary(input),
          yield* h.requests.title(input),
          yield* h.requests.generate(input),
          yield* h.requests.compaction(input),
        ]
        expect(prepared.map((item) => item.request.headers?.["X-Pacer-Where"])).toEqual([
          "~/repos/openforge@adj-of",
          "~/repos/openforge@adj-of",
          "~/repos/openforge@adj-of",
          "~/repos/openforge@adj-of",
        ])
        expect(asked).toEqual(["/project", "/project", "/project", "/project"])
        for (const other of others) {
          const plain = yield* h.requests.primary(h.input(snapshot(all), other.model))
          expect({ model: other.label, pacer: pacerHeaders(plain) }).toEqual({ model: other.label, pacer: [] })
        }
        expect(asked).toHaveLength(4)
      }),
  )
})

describe("SessionModelRequest telling CPP the agent's own Code Mode pins", () => {
  const pins = {
    web_search: { pinned: true, from: ".opencode/agent/build.md" },
    recall: { pinned: false, from: "opencode.json" },
  }
  /** A turn, a title, a generation and a compaction of the chat, each as it goes to the model. */
  const each = (h: Effect.Success<ReturnType<typeof setup>>, input: SessionModelRequest.Input) =>
    Effect.forEach([h.requests.primary, h.requests.title, h.requests.generate, h.requests.compaction], (request) =>
      Effect.gen(function* () {
        const prepared = yield* request(input)
        return {
          headers: prepared.request.headers,
          options: prepared.options,
          body: (yield* compileRequest(prepared.request)).body,
        }
      }),
    )

  it.effect("on the chat's tool list read only: each model request is what it is without them", () =>
    Effect.gen(function* () {
      const pinned = yield* setup()
      const plain = yield* setup()
      const sent = yield* each(pinned, { ...pinned.input(snapshot(all)), pins })
      const without = yield* each(plain, plain.input(snapshot(all)))
      const told = pinned.cpp.lists().map((read) => read.headers.get("x-pacer-pins"))
      expect(told).toHaveLength(1)
      expect(JSON.parse(decodeURIComponent(told[0]!))).toEqual(pins)
      expect(plain.cpp.lists().map((read) => read.headers.get("x-pacer-pins"))).toEqual([null])
      // The same headers, system prompt, tools and messages, byte for byte, on every kind of request.
      expect(sent[0]?.headers?.["X-Pacer-Agent"]).toBe("build")
      expect(JSON.stringify(sent[0]?.body)).toContain(cppTools(["web_search"]).slice(1, -1))
      expect(JSON.stringify(sent)).toBe(JSON.stringify(without))
      expect(
        sent.flatMap((request) => Object.keys(request.headers ?? {})).filter((name) => /pins/i.test(name)),
      ).toEqual([])
    }),
  )
})
