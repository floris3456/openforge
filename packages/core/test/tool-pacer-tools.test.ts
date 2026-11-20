import { describe, expect } from "bun:test"
import { ToolDefinition } from "@opencode/ai/effect"
import { Context, DateTime, Effect, Layer, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { Money } from "@opencode/schema/money"
import { Session as SessionInfo } from "@opencode/schema/session"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { Database } from "@opencode/core/database/database"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Image } from "@opencode/core/image"
import { ImageBank } from "@opencode/core/image/bank"
import { ImageFit } from "@opencode/core/image/fit"
import { ImageTable } from "@opencode/core/image/sql"
import { Location } from "@opencode/core/location"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionBlob } from "@opencode/core/session/blob"
import { SessionMessage } from "@opencode/core/session/message"
import { BlobRefTable, BlobTable, SessionTable } from "@opencode/core/session/sql"
import { Tool } from "@opencode/core/tool"
import { PacerToolsPlugin } from "@opencode/core/tool/plugin/pacer-tools"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { locationNode } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import {
  codeModeListings,
  executeTool,
  registerToolPlugin,
  toolDefinitions,
  toolIdentity,
  waitForCodeModeTool,
} from "./lib/tool"
import {
  catalogOf,
  endpointOf,
  fakeCpp,
  listOf,
  ownerList,
  settle,
  startTools,
  until,
  webMeta,
} from "./pacer/fake-tools"

// The one plugin that runs every tool CPP lists (workspace spec `docs/specs/cpp-tools.md`): it knows none of them, so a
// made-up tool of a test list is registered, asks its permission and is called as the web tools are.

const parentID = SessionInfo.ID.make("ses_pacer_tools_parent")
const sessionID = SessionInfo.ID.make("ses_pacer_tools_child")
const info = SessionInfo.Info.make({
  id: sessionID,
  parentID,
  projectID: Project.ID.make("4b825dc642cb6eb9a060e54bf8d69288fbee4904"),
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})

/** The store's answer for the chat: a subagent, whose calls name its parent; its metadata as the plugin sets it. */
const sessionsOf = (chat: { current: SessionInfo.Info }) =>
  Layer.mock(Session.Service, {
    get: () => Effect.sync(() => chat.current),
    setMetadata: (input) => Effect.sync(() => void (chat.current = { ...chat.current, metadata: input.metadata })),
    revert: {
      stage: () => Effect.die("unused"),
      clear: () => Effect.die("unused"),
      commit: () => Effect.die("unused"),
    },
  })

const pluginNode = makeLocationNode({
  name: "test/pacer-tools-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(PacerToolsPlugin.Plugin)),
  deps: [
    Tool.node,
    Permission.node,
    PacerTools.node,
    PacerProject.node,
    FileAccess.node,
    Environment.node,
    Session.node,
  ],
})

const it = testEffect(Layer.empty)

/** A made-up tool with no code of its own anywhere: its definition and meta are the test list's. */
const made = {
  name: "moon_phase",
  description: "Says the moon's phase on a day.",
  input_schema: { type: "object", properties: { day: { type: "string" }, places: { type: "array" } } },
}
const madeMeta = { title: "Moon phase", permission: "astronomy", subject: ["places", "day"], read_only: true }
const listed = {
  ...listOf("7e57000000000001", [...ownerList.tools.claude, made]),
  meta: { ...ownerList.meta, moon_phase: madeMeta },
}
/** CPP's `task`, whose `pictures` are local files (`meta.files`): the workspace reference's flow for them. */
const taskTool = {
  name: "task",
  description: "Reads or changes a task.",
  input_schema: {
    type: "object",
    properties: { id: { type: "string" }, items: { type: "array" }, pictures: { type: "array" } },
  },
}
const taskMeta = {
  title: "Task",
  permission: "memory",
  subject: ["id"],
  read_only: false,
  files: ["items", "pictures"],
}
const taskList = {
  ...listOf("7e57000000000003", [...ownerList.tools.claude, taskTool]),
  meta: { ...ownerList.meta, task: taskMeta },
}
const step = { sessionID, parentID, model: "claude-haiku-5-5", agent: "build", codemode: true, step: true, continues: false }

/** The real registry with the plugin, over a fake CPP whose list the chat has read once. */
const setup = Effect.fnUntraced(function* (
  options: {
    readonly read?: boolean
    readonly catalog?: PacerModels.Catalog
    /** CPP's list answer, which a test of files replaces; by default the moon phase tool's. */
    readonly list?: unknown
    /** The chat's folder: a temp one where a test writes the files it gives. */
    readonly directory?: string
  } = {},
) {
  const cpp = yield* fakeCpp
  cpp.answers.list = () => Response.json(options.list ?? listed)
  const started = yield* startTools(endpointOf(cpp.origin), options.catalog, undefined, {})
  const chat = { current: info }
  const asked: Array<Permission.AssertInput & { readonly calls: number }> = []
  const context = yield* Layer.build(
    AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode]), [
      Permission.node.replace(
        permissionLayer({
          assert: (input) => Effect.sync(() => void asked.push({ ...input, calls: cpp.calls().length })),
        }),
      ),
      PacerTools.node.replace(Layer.succeed(PacerTools.Service, started.tools)),
      Session.node.replace(sessionsOf(chat)),
      Image.node.replace(imagePassthrough),
      locationNode(options.directory ?? "/project"),
    ]),
  )
  const registry = Context.get(context, Tool.Service)
  if (options.read !== false) {
    yield* started.tools.list(step)
    yield* until("registered", () => Effect.runSync(names(registry)).length > 1)
  }
  const call = { sessionID, ...toolIdentity }
  const run = (name: string, input: unknown) =>
    executeTool(registry, { ...call, call: { type: "tool-call", id: `call-${name}`, name, input } })
  /** The failure itself, with its metadata, which the test helper leaves out. */
  const failure = (name: string, input: unknown) =>
    registry.snapshot().pipe(
      Effect.flatMap((tools) =>
        tools.execute({ ...call, call: { type: "tool-call", id: `call-${name}`, name, input } }),
      ),
      Effect.flip,
    )
  return { cpp, registry, started, asked, run, failure, chat }
})

const names = (registry: Tool.Interface, permissions?: Permission.Ruleset) =>
  toolDefinitions(registry, permissions).pipe(Effect.map((items) => items.map((item) => item.name)))
const all = ["moon_phase", "web_crawl", "web_extract", "web_research", "web_search", "execute"]

describe("PacerToolsPlugin registration", () => {
  it.effect("with an empty store, registers every tool capabilities' pacer.tools names before any list is read", () =>
    Effect.gen(function* () {
      // The first start after the upgrade: nothing kept, the catalog read at start names what the key may be listed.
      const h = yield* setup({ read: false, catalog: catalogOf(true, { ...webMeta, moon_phase: madeMeta }) })
      yield* until("registered", () => Effect.runSync(names(h.registry)).length > 1)
      expect(yield* names(h.registry)).toEqual(all)
      expect(h.cpp.lists()).toHaveLength(0)
      // Kept for the next start, and runs as any.
      const kept = yield* h.started.kv.get(PacerTools.knownKey(endpointOf(h.cpp.origin)))
      expect((kept as Record<string, unknown>).moon_phase).toEqual(madeMeta)
      expect((yield* h.run("moon_phase", { day: "today" })).status).toBe("completed")
      expect(h.asked.map((item) => [item.action, item.resources])).toEqual([["astronomy", ["today"]]])
    }),
  )

  it.effect("adds what each later capabilities read names, and keeps the ones it no longer names", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false, catalog: catalogOf(true, webMeta) })
      yield* until("registered", () => Effect.runSync(names(h.registry)).length > 1)
      expect(yield* names(h.registry)).toEqual(all.filter((name) => name !== "moon_phase"))
      // Memory switched on adds its tools; one whose meta this version can't read was dropped by the catalog.
      yield* SubscriptionRef.set(h.started.catalogs, catalogOf(true, { moon_phase: madeMeta }))
      yield* until("added", () => Effect.runSync(names(h.registry)).includes("moon_phase"))
      expect(yield* names(h.registry)).toEqual(all)
    }),
  )

  it.effect("on a server whose capabilities lack pacer.tools, registers none until a list is read", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false, catalog: catalogOf(true) })
      yield* settle
      expect(yield* names(h.registry)).toEqual(["execute"])
    }),
  )

  it.effect("registers a direct tool for every name CPP's lists named, once one was read, and none before", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false })
      expect(yield* names(h.registry)).toEqual(["execute"])
      yield* h.started.tools.list(step)
      yield* until("registered", () => Effect.runSync(names(h.registry)).length > 1)
      // Direct, beside Code Mode's `execute`, not inside it.
      expect(yield* names(h.registry)).toEqual(all)
    }),
  )

  it.effect("keeps them for the endpoint across a restart, from the store, before any list is read again", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const kept = yield* h.started.kv.get(PacerTools.knownKey(endpointOf(h.cpp.origin)))
      expect(Object.keys(kept as object).toSorted()).toEqual(all.filter((name) => name !== "execute"))
      expect((kept as Record<string, unknown>).moon_phase).toEqual(madeMeta)
      // A new PacerTools over the same store, as after a restart: what it knows is there at once.
      const again = yield* startTools(endpointOf(h.cpp.origin), undefined, h.started.kv)
      expect([...(yield* again.tools.known()).keys()].toSorted()).toEqual(all.filter((name) => name !== "execute"))
      expect(h.cpp.lists()).toHaveLength(1)
    }),
  )

  it.effect("drops every one when the endpoint goes, and has another server's own when it is set", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* SubscriptionRef.set(h.started.endpoints, undefined)
      yield* until("removed", () => Effect.runSync(names(h.registry)).length === 1)
      // Another server, whose lists were never read (a closed port: nothing is asked of it here).
      yield* SubscriptionRef.set(h.started.endpoints, endpointOf("http://127.0.0.1:9"))
      expect(yield* names(h.registry)).toEqual(["execute"])
      // Back at the first one, its tools come back from the store.
      yield* SubscriptionRef.set(h.started.endpoints, endpointOf(h.cpp.origin))
      yield* until("back", () => Effect.runSync(names(h.registry)).length > 1)
      expect(yield* names(h.registry)).toEqual(all)
    }),
  )

  it.effect("leaves out the tools whose permission an agent denies, by their meta's permission", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const deny = (action: string): Permission.Ruleset => [{ action, resource: "*", effect: "deny" }]
      expect(yield* names(h.registry, deny("websearch"))).toEqual(["moon_phase", "web_crawl", "web_extract", "execute"])
      expect(yield* names(h.registry, deny("webfetch"))).toEqual([
        "moon_phase",
        "web_research",
        "web_search",
        "execute",
      ])
      expect(yield* names(h.registry, deny("astronomy"))).toEqual(all.filter((name) => name !== "moon_phase"))
      // A rule on a resource governs calls, not whether the tool is offered.
      expect(yield* names(h.registry, [{ action: "websearch", resource: "*.example", effect: "deny" }])).toEqual(all)
    }),
  )
})

describe("PacerToolsPlugin calls", () => {
  it.effect("a made-up tool asks its meta's permission on its subject, is called, and its answer lands", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      h.cpp.answers.call = () =>
        Response.json({
          text: "Full moon in Ghent.",
          data: { anything: true },
          error: null,
          metadata: { phase: "full", places: 1 },
          place: { task: "t1", subtask: null },
        })
      expect(yield* h.run("moon_phase", { day: "2026-11-24", places: ["Ghent", 3, "Gent"] })).toEqual({
        status: "completed",
        content: [{ type: "text", text: "Full moon in Ghent." }],
        metadata: { phase: "full", places: 1 },
      })
      // The first subject the call holds: `places`, its strings.
      expect(h.asked.map((item) => [item.action, item.resources])).toEqual([["astronomy", ["Ghent", "Gent"]]])
      expect(h.asked[0]).toMatchObject({
        sessionID,
        agent: toolIdentity.agent,
        save: ["*"],
        source: { type: "tool", messageID: toolIdentity.messageID, id: "call-moon_phase" },
      })
      expect(h.asked[0]!.calls).toBe(0)
      const [sent] = h.cpp.calls()
      expect([sent?.path, sent?.body]).toEqual([
        "/pacer/v1/tools/moon_phase",
        JSON.stringify({ day: "2026-11-24", places: ["Ghent", 3, "Gent"] }),
      ])
      expect(sent?.headers.get("x-pacer-session")).toBe(PacerSessionID.make(sessionID))
      expect(sent?.headers.get("x-pacer-parent-session")).toBe(PacerSessionID.make(parentID))
      expect(sent?.headers.get("x-pacer-project")).toBe(info.projectID)
      expect(sent?.headers.get("x-pacer-agent")).toBe(toolIdentity.agent)
      expect(sent?.headers.get("x-pacer-chat")).toBe(sessionID)
      // CPP's place lands in the session's metadata.
      expect(h.chat.current.metadata).toEqual({ memory: { task: "t1" } })

      // Without its subject, on `*`; a place of null takes the chat out of its task; none sent leaves it.
      h.cpp.answers.call = () => Response.json({ text: "ok", data: null, error: null, place: null })
      yield* h.run("moon_phase", {})
      expect(h.asked.at(-1)?.resources).toEqual(["*"])
      expect(h.chat.current.metadata).toEqual({})
      h.chat.current = { ...h.chat.current, metadata: { memory: { task: "t2", subtask: "s2" } } }
      h.cpp.answers.call = () => Response.json({ text: "ok", data: null, error: null })
      expect((yield* h.run("moon_phase", { day: "today" })).metadata).toEqual({})
      expect(h.asked.at(-1)?.resources).toEqual(["today"])
      expect(h.chat.current.metadata).toEqual({ memory: { task: "t2", subtask: "s2" } })
    }),
  )

  it.effect("asks the web tools as their meta says: the query or question, the URLs, a job's id first", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const calls = [
        ["web_search", { query: "rust 1.95 release notes", recency: "month" }],
        ["web_research", { question: "Which rust release added let chains?", depth: "deep" }],
        ["web_extract", { urls: ["https://a.example/1", "https://b.example/2"], format: "text" }],
        ["web_crawl", { url: "https://docs.example/", limit: 5 }],
        ["web_research", { job_id: "job_0123456789abcdef0123456789abcdef" }],
        ["web_crawl", { job_id: "job_fedcba9876543210fedcba9876543210", cancel: true }],
      ] as const
      for (const [name, input] of calls) expect((yield* h.run(name, input)).status).toBe("completed")
      expect(h.asked.map((item) => [item.action, item.resources])).toEqual([
        ["websearch", ["rust 1.95 release notes"]],
        ["websearch", ["Which rust release added let chains?"]],
        ["webfetch", ["https://a.example/1", "https://b.example/2"]],
        ["webfetch", ["https://docs.example/"]],
        ["websearch", ["job_0123456789abcdef0123456789abcdef"]],
        ["webfetch", ["job_fedcba9876543210fedcba9876543210"]],
      ])
      expect(h.asked.map((item) => item.calls)).toEqual([0, 1, 2, 3, 4, 5])
    }),
  )

  it.effect("calls nothing when the permission is denied", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      cpp.answers.list = () => Response.json(listed)
      const started = yield* startTools(endpointOf(cpp.origin), undefined, undefined, {})
      yield* started.tools.list(step)
      const context = yield* Layer.build(
        AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode]), [
          Permission.node.replace(
            permissionLayer({
              assert: (input) =>
                new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }),
            }),
          ),
          PacerTools.node.replace(Layer.succeed(PacerTools.Service, started.tools)),
          Session.node.replace(sessionsOf({ current: info })),
          Image.node.replace(imagePassthrough),
          locationNode("/project"),
        ]),
      )
      const result = yield* executeTool(Context.get(context, Tool.Service), {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-denied", name: "moon_phase", input: { day: "today" } },
      })
      expect(result).toMatchObject({
        status: "error",
        error: { type: "permission.rejected", message: "Permission denied: astronomy" },
      })
      expect(cpp.calls()).toHaveLength(0)
    }),
  )

  it.effect("keeps CPP's metadata as the call's: the service as CPP names it, and the job while one runs", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      h.cpp.answers.call = () =>
        Response.json({
          text: "Web research: started.",
          data: { tool: "web_research", job_id: "job_0123", provider: "exa" },
          error: null,
          metadata: { provider: "Exa", job: { id: "job_0123", status: "running" } },
        })
      expect((yield* h.run("web_research", { question: "q" })).metadata).toEqual({
        provider: "Exa",
        job: { id: "job_0123", status: "running" },
      })
    }),
  )
})

describe("PacerToolsPlugin answers", () => {
  it.effect("200 with error: fails with CPP's text and keeps its metadata", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const text = "Web search failed: the query is mostly a secret, so it was not sent. Go on without it."
      h.cpp.answers.call = () =>
        Response.json({
          text,
          data: { tool: "web_search" },
          error: { code: "secret_query", message: "the query is mostly a secret, so it was not sent" },
          metadata: { error: "secret_query" },
        })
      const failed = yield* h.failure("web_search", { query: "sk-…" })
      expect(failed.message).toBe(text)
      expect(failed.metadata).toEqual({ error: "secret_query" })
      expect(yield* h.run("web_search", { query: "sk-…" })).toMatchObject({
        status: "error",
        error: { type: "tool.execution", message: text },
      })
    }),
  )

  it.effect("400: fails naming CPP's problems, so the model can fix its arguments", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      h.cpp.answers.call = () =>
        Response.json(
          { error: { type: "invalid_request", message: "moon_phase has no year" } },
          {
            status: 400,
          },
        )
      expect(yield* h.run("moon_phase", { year: 1 })).toMatchObject({
        status: "error",
        error: {
          type: "tool.execution",
          message: "CLIProxyPacer refused the arguments of moon_phase: moon_phase has no year",
        },
      })
    }),
  )

  it.effect("404: fails, and the chat's list is read again at its next request", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      h.cpp.answers.call = () =>
        Response.json({ error: { type: "not_found", message: "no tool web_crawl" } }, { status: 404 })
      expect(yield* h.run("web_crawl", { url: "https://a.example/" })).toMatchObject({
        status: "error",
        error: { type: "tool.execution", message: "CLIProxyPacer has no tool web_crawl" },
      })
      yield* h.started.tools.list(step)
      expect(h.cpp.lists()).toHaveLength(2)
    }),
  )

  it.effect("unreachable: fails, saying CPP could not be reached", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* Effect.promise(() => h.cpp.server.stop(true))
      const result = yield* h.run("web_search", { query: "q" })
      expect(result.status).toBe("error")
      expect(result.error?.message).toStartWith("CLIProxyPacer could not be reached: ")
    }),
  )
})

// Web tools in Code Mode (workspace spec `docs/specs/web-tools-code-mode.md`): CPP's meta places each tool, and a Code
// Mode tool is described by CPP's definition, so Code Mode's catalog and `search` show it.
describe("PacerToolsPlugin in Code Mode", () => {
  const placed = { ...madeMeta, codemode: true }
  const definition = { description: made.description, input_schema: made.input_schema }
  const inCode = (code: string) => ({ code })
  /** Runs `code` in the registry's `execute`, as a model's call of it. */
  const script = (registry: Tool.Interface, code: string) =>
    executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call-execute", name: "execute", input: inCode(code) },
    })

  it.effect("registers a tool its meta places in Code Mode with capabilities' definition, beside the direct ones", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        read: false,
        catalog: catalogOf(true, { moon_phase: { ...placed, definition }, ...webMeta }),
      })
      const snapshot = yield* waitForCodeModeTool(h.registry, "moon_phase")
      // Not on the direct list; the web tools, whose meta says nothing of it, stay there.
      expect(snapshot.definitions.map((item) => item.name)).toEqual(all.filter((name) => name !== "moon_phase"))
      const [listing] = codeModeListings(snapshot.codeModeCatalog!).filter((item) => item.path === "moon_phase")
      expect(listing?.line).toContain("tools.moon_phase(")
      expect(listing?.line).toContain("day?: string")
      expect(listing?.line).toContain(`// ${made.description}`)
      expect(h.cpp.lists()).toHaveLength(0)
    }),
  )

  it.effect("runs inside execute: asks its permission, calls CPP, and its row under execute keeps CPP's metadata", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false, catalog: catalogOf(true, { moon_phase: { ...placed, definition } }) })
      yield* waitForCodeModeTool(h.registry, "moon_phase")
      h.cpp.answers.call = () =>
        Response.json({ text: "Full moon in Ghent.", data: null, error: null, metadata: { provider: "Moonwatch" } })
      const result = yield* script(h.registry, 'return await tools.moon_phase({ day: "2026-11-24" })')
      expect(result.status).toBe("completed")
      expect(result.content).toEqual([{ type: "text", text: "Full moon in Ghent." }])
      expect(result.metadata?.toolCalls).toEqual([
        { tool: "moon_phase", status: "completed", input: { day: "2026-11-24" }, metadata: { provider: "Moonwatch" } },
      ])
      expect(h.asked.map((item) => [item.action, item.resources])).toEqual([["astronomy", ["2026-11-24"]]])
      expect(h.cpp.calls().map((item) => item.path)).toEqual(["/pacer/v1/tools/moon_phase"])
    }),
  )

  it.effect("a tool its meta marks pinned stays listed when the catalog has no budget left", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        read: false,
        catalog: catalogOf(true, { moon_phase: { ...placed, pinned: true, definition } }),
      })
      const snapshot = yield* waitForCodeModeTool(h.registry, "moon_phase")
      const shown = (budget: number) =>
        CodeModeCatalog.summarize(snapshot.codeModeCatalog!, { budget }).namespaces.flatMap((namespace) =>
          namespace.entries.map((entry) => entry.path),
        )
      // The web tools, unpinned ones, are not listed; the pinned one is, whatever the budget.
      expect(shown(0)).toEqual(["moon_phase"])
      expect(shown(Infinity)).toContain("moon_phase")
    }),
  )

  it.effect("a tool its meta reports answers the model even when the script does not return it", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        read: false,
        catalog: catalogOf(true, { moon_phase: { ...placed, reported: true, definition } }),
      })
      yield* waitForCodeModeTool(h.registry, "moon_phase")
      h.cpp.answers.call = () => Response.json({ text: "Full moon in Ghent.", data: null, error: null })
      const ignored = yield* script(h.registry, 'await tools.moon_phase({ day: "today" }); return "Scripted."')
      expect(ignored.content).toEqual([
        { type: "text", text: "Scripted.\n\ntools.moon_phase(…) answered:\nFull moon in Ghent." },
      ])
      // The script returns the answer itself: it stays where it returned it, once.
      const returned = yield* script(h.registry, 'return await tools.moon_phase({ day: "today" })')
      expect(returned.content).toEqual([{ type: "text", text: "Full moon in Ghent." }])
    }),
  )

  it.effect("a reported answer returned in an array or object comes once, and answers keep their call order", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        read: false,
        catalog: catalogOf(true, { moon_phase: { ...placed, reported: true, definition } }),
      })
      yield* waitForCodeModeTool(h.registry, "moon_phase")
      // A newline and quotes, which JSON escapes inside an array or object.
      const moon = (day: string) => `Moon on ${day}:\n"full"`
      h.cpp.answers.call = (request) =>
        Response.json({ text: moon(request.body.includes("Tuesday") ? "Tuesday" : "Monday"), data: null, error: null })
      const listed = yield* script(
        h.registry,
        'return [await tools.moon_phase({ day: "Monday" }), await tools.moon_phase({ day: "Tuesday" })]',
      )
      expect(listed.content).toEqual([{ type: "text", text: JSON.stringify([moon("Monday"), moon("Tuesday")]) }])
      const kept = yield* script(h.registry, 'return { first: await tools.moon_phase({ day: "Monday" }) }')
      expect(kept.content).toEqual([{ type: "text", text: JSON.stringify({ first: moon("Monday") }) }])
      // Only the last call's answer returned: both answers, in the order of their calls.
      const last = yield* script(
        h.registry,
        'await tools.moon_phase({ day: "Monday" }); return await tools.moon_phase({ day: "Tuesday" })',
      )
      expect(last.content).toEqual([
        {
          type: "text",
          text: `tools.moon_phase(…) answered:\n${moon("Monday")}\n\ntools.moon_phase(…) answered:\n${moon("Tuesday")}`,
        },
      ])
    }),
  )

  it.effect("an unreported tool's answer is lost when the script does not return it", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false, catalog: catalogOf(true, { moon_phase: { ...placed, definition } }) })
      yield* waitForCodeModeTool(h.registry, "moon_phase")
      h.cpp.answers.call = () => Response.json({ text: "Full moon in Ghent.", data: null, error: null })
      const result = yield* script(h.registry, 'await tools.moon_phase({ day: "today" }); return "Scripted."')
      expect(result.content).toEqual([{ type: "text", text: "Scripted." }])
    }),
  )

  it.effect("a failed call's row keeps CPP's metadata too, and the script sees CPP's text", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false, catalog: catalogOf(true, { moon_phase: { ...placed, definition } }) })
      yield* waitForCodeModeTool(h.registry, "moon_phase")
      h.cpp.answers.call = () =>
        Response.json({ text: "Clouded over.", data: null, error: { code: "clouds" }, metadata: { error: "clouds" } })
      const result = yield* script(
        h.registry,
        'try { await tools.moon_phase({ day: "today" }) } catch (error) { return String(error.message) }',
      )
      expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Clouded over.") }])
      expect(result.metadata?.toolCalls).toEqual([
        { tool: "moon_phase", status: "error", input: { day: "today" }, metadata: { error: "clouds" } },
      ])
    }),
  )

  it.effect("takes a list's definition when capabilities give none, and capabilities' over any list's", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false })
      h.cpp.answers.list = () => Response.json({ ...listed, meta: { ...listed.meta, moon_phase: placed } })
      yield* h.started.tools.list(step)
      const first = yield* waitForCodeModeTool(h.registry, "moon_phase")
      expect(codeModeListings(first.codeModeCatalog!).find((item) => item.path === "moon_phase")?.line).toContain(
        made.description,
      )
      // Another chat's copy, of other bytes, doesn't take the catalog over.
      const other = { ...made, description: "Another chat's copy of the moon." }
      h.cpp.answers.list = () =>
        Response.json({
          ...listOf("7e57000000000002", [...ownerList.tools.claude, other]),
          meta: { ...listed.meta, moon_phase: placed },
        })
      yield* h.started.tools.list({ ...step, sessionID: SessionInfo.ID.make("ses_pacer_tools_other") })
      yield* settle
      const kept = (yield* h.started.tools.known()).get("moon_phase")
      expect(kept?.definition?.description).toBe(made.description)
      // Capabilities' does.
      const now = { description: "The moon, as CPP describes it now.", input_schema: made.input_schema }
      yield* SubscriptionRef.set(h.started.catalogs, catalogOf(true, { moon_phase: { ...placed, definition: now } }))
      yield* until("described", () =>
        codeModeListings(Effect.runSync(h.registry.snapshot()).codeModeCatalog!).some((item) =>
          item.line.includes(now.description),
        ),
      )
    }),
  )

  it.effect("a chat whose list doesn't hold it is answered that it is unavailable, and CPP is not called", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false, catalog: catalogOf(true, { moon_phase: { ...placed, definition } }) })
      yield* waitForCodeModeTool(h.registry, "moon_phase")
      // Before the chat's list is read, CPP decides.
      expect((yield* script(h.registry, 'return await tools.moon_phase({ day: "today" })')).status).toBe("completed")
      // The chat's list, without it.
      h.cpp.answers.list = () => Response.json(ownerList)
      yield* h.started.tools.list(step)
      const result = yield* script(
        h.registry,
        'try { await tools.moon_phase({ day: "today" }) } catch (error) { return String(error.message) }',
      )
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining("moon_phase is not available in this chat.") },
      ])
      expect(h.cpp.calls()).toHaveLength(1)
    }),
  )

  it.effect("a warm chat's recorded start that offers it as a direct tool still runs it directly", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false, catalog: catalogOf(true, { moon_phase: { ...placed, definition } }) })
      const snapshot = yield* waitForCodeModeTool(h.registry, "moon_phase")
      const call = { type: "tool-call" as const, id: "call-direct", name: "moon_phase", input: { day: "today" } }
      // Offered directly by the request, as a chat recorded before the move sends it.
      const offered = new Map([
        [
          "moon_phase",
          new ToolDefinition({ name: "moon_phase", description: "As recorded.", inputSchema: made.input_schema }),
        ],
      ])
      const ran = yield* snapshot.execute({ sessionID, ...toolIdentity, call, definitions: offered })
      expect(ran.content).toEqual([{ type: "text", text: "answered /pacer/v1/tools/moon_phase" }])
    }),
  )

  it.effect("a direct call of it, which the request offers only in Code Mode, runs it as a script's call would", () =>
    Effect.gen(function* () {
      const h = yield* setup({ read: false, catalog: catalogOf(true, { moon_phase: { ...placed, definition } }) })
      const snapshot = yield* waitForCodeModeTool(h.registry, "moon_phase")
      h.cpp.answers.call = () => Response.json({ text: "Full moon in Ghent.", data: null, error: null })
      const call = { type: "tool-call" as const, id: "call-direct", name: "moon_phase", input: { day: "today" } }
      const ran = yield* snapshot.execute({ sessionID, ...toolIdentity, call, definitions: new Map() })
      expect(ran.content).toEqual([{ type: "text", text: "Full moon in Ghent." }])
      expect(h.asked.map((item) => [item.action, item.resources])).toEqual([["astronomy", ["today"]]])
      expect(h.cpp.calls().map((item) => item.path)).toEqual(["/pacer/v1/tools/moon_phase"])
      // Wholly denied by the rules in force: denied, and CPP is not called.
      const denied = yield* h.registry.snapshot([{ action: "astronomy", resource: "*", effect: "deny" }])
      const refused = yield* denied
        .execute({ sessionID, ...toolIdentity, call, definitions: new Map() })
        .pipe(Effect.flip)
      expect(refused.message).toBe("Permission denied: moon_phase")
      expect(h.cpp.calls()).toHaveLength(1)
    }),
  )
})

// CPP's `meta.files` (workspace reference `docs/reference/review-api.md`, "openforge" and the task tool): the strings of
// those arguments are local files or `#N` of the chat, which are uploaded once and sent by their hash. A picture that
// cannot go answers the model instead of the call, so nothing of it reaches CPP.
describe("PacerToolsPlugin files", () => {
  // A real 1x1 PNG; nothing decodes it here, its bytes are hashed and sent. Its comparison differs by a byte.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  )
  const before = Buffer.concat([png, Buffer.from([0])])
  const sha = (bytes: Uint8Array) => SessionBlob.hashBytes(bytes)
  /** What CPP got as a call's arguments, which is the model's own input with the files' hashes in their place. */
  const sent = (h: { readonly cpp: { readonly calls: () => ReadonlyArray<{ readonly body: string }> } }, index = 0) =>
    JSON.parse(h.cpp.calls()[index]!.body)

  it.effect("uploads a picture written as a path once, sends its hash in its place, and asks a read for it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(`${tmp.path}/after.png`, png))
      const h = yield* setup({ list: taskList, directory: tmp.path })
      expect((yield* h.run("task", { id: "t1", pictures: ["after.png"] })).status).toBe("completed")
      expect(sent(h)).toEqual({ id: "t1", pictures: [{ sha256: sha(png), name: "after.png" }] })
      expect(h.cpp.heads().map((one) => one.sha256)).toEqual([sha(png)])
      expect(h.cpp.puts()).toHaveLength(1)
      expect(Buffer.from(h.cpp.puts()[0]!.bytes).equals(png)).toBe(true)
      expect(h.cpp.puts()[0]!.headers.get("content-type")).toBe("image/png")
      expect(h.cpp.files.get(sha(png))?.type).toBe("image/png")
      // The call's own input stays what the model wrote: the path, as the permission was asked with it.
      expect(h.asked[0]).toMatchObject({ action: "memory", metadata: { id: "t1", pictures: ["after.png"] } })
      expect(h.asked.map((one) => one.action)).toEqual(["memory", "read"])
      // Given again, the file is known held: neither a HEAD nor a PUT.
      yield* h.run("task", { id: "t1", pictures: ["after.png"] })
      expect(h.cpp.calls()).toHaveLength(2)
      expect(h.cpp.uploads).toHaveLength(2)
      expect(sent(h, 1)).toEqual({ id: "t1", pictures: [{ sha256: sha(png), name: "after.png" }] })
    }),
  )

  it.effect(
    "asks again whether CPP holds a picture an hour after it learnt so, and sends it only when it does not",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* Effect.promise(() => Bun.write(`${tmp.path}/after.png`, png))
        const h = yield* setup({ list: taskList, directory: tmp.path })
        yield* h.run("task", { id: "t1", pictures: ["after.png"] })
        yield* TestClock.adjust("59 minutes")
        yield* h.run("task", { id: "t1", pictures: ["after.png"] })
        expect(h.cpp.heads()).toHaveLength(1)
        yield* TestClock.adjust("1 minute")
        yield* h.run("task", { id: "t1", pictures: ["after.png"] })
        // held still: asked, not sent
        expect(h.cpp.heads()).toHaveLength(2)
        expect(h.cpp.puts()).toHaveLength(1)
        // CPP dropped it (a week with no round naming it): asked, and sent again
        h.cpp.files.delete(sha(png))
        yield* TestClock.adjust("1 hour")
        yield* h.run("task", { id: "t1", pictures: ["after.png"] })
        expect(h.cpp.heads()).toHaveLength(3)
        expect(h.cpp.puts()).toHaveLength(2)
        expect(sent(h, 3)).toEqual({ id: "t1", pictures: [{ sha256: sha(png), name: "after.png" }] })
      }),
  )

  it.effect("replaces both files of a [picture, comparison, caption] item, and keeps the caption", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Promise.all([Bun.write(`${tmp.path}/after.png`, png), Bun.write(`${tmp.path}/before.png`, before)]),
      )
      const h = yield* setup({ list: taskList, directory: tmp.path })
      yield* h.run("task", { id: "t1", pictures: [["after.png", "before.png", "from the driver's seat"]] })
      expect(sent(h)).toEqual({
        id: "t1",
        pictures: [
          [
            { sha256: sha(png), name: "after.png" },
            { sha256: sha(before), name: "before.png" },
            "from the driver's seat",
          ],
        ],
      })
      expect(h.cpp.puts().map((one) => one.sha256)).toEqual([sha(png), sha(before)])
      // A caption alone is text, and a null comparison no file: neither is touched.
      yield* h.run("task", { id: "t1", pictures: [["after.png", null, "#1 is a number, not a picture"]] })
      expect(sent(h, 1)).toEqual({
        id: "t1",
        pictures: [[{ sha256: sha(png), name: "after.png" }, null, "#1 is a number, not a picture"]],
      })
    }),
  )

  it.effect("takes #N from the chat's image bank by its original's hash, without reading a path", () =>
    Effect.gen(function* () {
      const database = yield* Layer.build(AppNodeBuilder.build(LayerNode.group([Database.node])))
      const db = Context.get(database, Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: sessionID,
          directory: "/project",
          title: "bank",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const hash = sha(png)
      yield* db
        .insert(BlobTable)
        .values({ hash, mime: "image/png", bytes: png.length, width: 1, height: 1, data: png })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(BlobRefTable)
        .values({ session_id: sessionID, message_id: SessionMessage.ID.make("msg_image_bank"), hash, seq: 0 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ImageTable)
        .values({
          session_id: sessionID,
          number: 1,
          hash,
          name: "shot.png",
          width: 1,
          height: 1,
          shown_width: 1,
          shown_height: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const h = yield* setup({ list: taskList })
      const call = (input: unknown) => ({
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call" as const, id: "call-task", name: "task", input },
      })
      const bank = { db, sessionID, model: ImageFit.MODELS["claude-opus-5-5"]! }
      const run = (input: unknown) =>
        h.registry.snapshot().pipe(
          Effect.flatMap((tools) => tools.execute(call(input))),
          Effect.provideService(ImageBank.Current, bank),
        )
      yield* run({ id: "t1", pictures: ["#1"] })
      expect(sent(h)).toEqual({ id: "t1", pictures: [{ sha256: hash, name: "image 1" }] })
      // The original's own bytes, sent as the bank keeps them.
      expect(Buffer.from(h.cpp.puts()[0]!.bytes).equals(png)).toBe(true)
      // No path was read for it: only the tool's own permission was asked.
      expect(h.asked.map((one) => one.action)).toEqual(["memory"])
      // A number the chat does not hold, and a chat whose images are not numbered at all, answer without a call.
      expect((yield* run({ id: "t1", pictures: ["#2"] }).pipe(Effect.flip)).message).toBe(
        "Not sent: #2 is not an image of this chat",
      )
      const unnumbered = yield* h.registry.snapshot().pipe(
        Effect.flatMap((tools) => tools.execute(call({ id: "t1", pictures: ["#1"] }))),
        Effect.flip,
      )
      expect(unnumbered.message).toBe("Not sent: #1 is not an image of this chat")
      expect(h.cpp.calls()).toHaveLength(1)
      expect(h.cpp.uploads).toHaveLength(2)
    }),
  )

  it.effect("answers a missing file, and one that is not a picture or is too big, without calling the tool", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(`${tmp.path}/notes.pdf`, "%PDF-1.7 plain words"))
      yield* Effect.promise(() => Bun.write(`${tmp.path}/huge.png`, new Uint8Array(21 * 1024 * 1024)))
      const h = yield* setup({ list: taskList, directory: tmp.path })
      const asked = (pictures: ReadonlyArray<string>) =>
        h.failure("task", { id: "t1", pictures }).pipe(Effect.map((error) => error.message))
      expect(yield* asked(["run/evidence/gone.png"])).toBe("Not sent: run/evidence/gone.png does not exist")
      expect(yield* asked(["notes.pdf"])).toBe("Not sent: notes.pdf is not a picture or a text (.md, .txt)")
      expect(yield* asked(["huge.png"])).toBe("Not sent: huge.png is 21 MB, over 20 MB")
      // A missing file after a good one still sends nothing, as the good one is only in the arguments being built.
      expect(yield* asked(["notes.pdf"])).toBe("Not sent: notes.pdf is not a picture or a text (.md, .txt)")
      expect(h.cpp.calls()).toHaveLength(0)
      expect(h.cpp.uploads).toHaveLength(0)
    }),
  )

  // The workspace's spec docs/specs/review-items.md, sections 4 and 8: `items` names its parts, and a text is a file too.
  it.effect("uploads a .md or .txt path once as text, named by its base name, and sends its hash in its place", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const spec = new TextEncoder().encode("# Spec\n\nThe dock lists two projects: é.\n")
      yield* Effect.promise(() =>
        Promise.all([Bun.write(`${tmp.path}/spec.md`, spec), Bun.write(`${tmp.path}/notes.txt`, "plain words")]),
      )
      const h = yield* setup({ list: taskList, directory: tmp.path })
      yield* h.run("task", { id: "t1", items: ["spec.md", { text: "notes.txt", comment: "the notes" }] })
      expect(sent(h)).toEqual({
        id: "t1",
        items: [
          { sha256: sha(spec), name: "spec.md" },
          { text: { sha256: sha(new TextEncoder().encode("plain words")), name: "notes.txt" }, comment: "the notes" },
        ],
      })
      expect(h.cpp.puts().map((one) => one.headers.get("content-type"))).toEqual(["text/markdown", "text/plain"])
      expect(Buffer.from(h.cpp.puts()[0]!.bytes).equals(Buffer.from(spec))).toBe(true)
      // Given again, it is known held: one upload each.
      yield* h.run("task", { id: "t1", items: ["spec.md"] })
      expect(h.cpp.puts()).toHaveLength(2)
    }),
  )

  it.effect(
    "answers a text that is not UTF-8 or over 256 KB, and anything else that is no picture, without a call",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(`${tmp.path}/broken.txt`, new Uint8Array([0x61, 0xff, 0xfe])),
            Bun.write(`${tmp.path}/long.md`, "a".repeat(256 * 1024 + 1)),
            Bun.write(`${tmp.path}/paper.pdf`, "%PDF-1.7"),
          ]),
        )
        const h = yield* setup({ list: taskList, directory: tmp.path })
        const asked = (items: ReadonlyArray<unknown>) =>
          h.failure("task", { id: "t1", items }).pipe(Effect.map((error) => error.message))
        expect(yield* asked(["broken.txt"])).toBe("Not sent: broken.txt is not UTF-8 text")
        expect(yield* asked([{ text: "long.md" }])).toBe("Not sent: long.md is 257 KB, over 256 KB")
        expect(yield* asked(["paper.pdf"])).toBe("Not sent: paper.pdf is not a picture or a text (.md, .txt)")
        expect(yield* asked([{ picture: "paper.pdf" }])).toBe(
          "Not sent: paper.pdf is not a picture or a text (.md, .txt)",
        )
        expect(h.cpp.calls()).toHaveLength(0)
        expect(h.cpp.uploads).toHaveLength(0)
      }),
  )

  it.effect("uploads a named entry's picture and compare, and passes a decision on as written", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Promise.all([Bun.write(`${tmp.path}/after.png`, png), Bun.write(`${tmp.path}/before.png`, before)]),
      )
      const h = yield* setup({ list: taskList, directory: tmp.path })
      const decision = {
        decide: "Raise the JS budget to 272,545 B?",
        options: ["Raise it", "Keep it, cut the page"],
        comment: "the review page needs it",
      }
      yield* h.run("task", {
        id: "t1",
        state: "review",
        items: [{ picture: "after.png", compare: "before.png", comment: "from the seat" }, decision],
      })
      expect(sent(h)).toEqual({
        id: "t1",
        state: "review",
        items: [
          {
            picture: { sha256: sha(png), name: "after.png" },
            compare: { sha256: sha(before), name: "before.png" },
            comment: "from the seat",
          },
          decision,
        ],
      })
      expect(h.cpp.puts().map((one) => one.sha256)).toEqual([sha(png), sha(before)])
      // A warm chat's `pictures` beside it, named in meta.files too, as before.
      yield* h.run("task", { id: "t1", pictures: [["after.png", null, "seat"]] })
      expect(sent(h, 1)).toEqual({ id: "t1", pictures: [[{ sha256: sha(png), name: "after.png" }, null, "seat"]] })
    }),
  )

  it.effect("refuses more than 20 items before any of them is read", () =>
    Effect.gen(function* () {
      const h = yield* setup({ list: taskList })
      const failed = yield* h.failure("task", { id: "t1", pictures: Array.from({ length: 21 }, () => "#1") })
      expect(failed.message).toBe("Not sent: pictures has more than 20 items")
      expect(h.cpp.calls()).toHaveLength(0)
      expect(h.asked.map((one) => one.action)).toEqual(["memory"])
    }),
  )

  it.effect("takes an SVG by its markup, after its declaration and comments, or by its name and text", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const svg = new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn by d2 -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
      )
      // A doctype before the markup is not the start a sniff reads: the `.svg` name and its text say what it is.
      const doctype = new TextEncoder().encode('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">\n<svg/>')
      yield* Effect.promise(() =>
        Promise.all([Bun.write(`${tmp.path}/chart.svg`, svg), Bun.write(`${tmp.path}/other.svg`, doctype)]),
      )
      const h = yield* setup({ list: taskList, directory: tmp.path })
      yield* h.run("task", { id: "t1", pictures: ["chart.svg", "other.svg"] })
      expect(sent(h)).toEqual({
        id: "t1",
        pictures: [
          { sha256: sha(svg), name: "chart.svg" },
          { sha256: sha(doctype), name: "other.svg" },
        ],
      })
      expect(h.cpp.files.get(sha(svg))?.type).toBe("image/svg+xml")
      expect(h.cpp.files.get(sha(doctype))?.type).toBe("image/svg+xml")
    }),
  )

  it.effect("leaves the arguments of a tool whose meta names no files untouched", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const input = { day: "#1", places: ["after.png", 3] }
      yield* h.run("moon_phase", input)
      expect(sent(h)).toEqual(input)
      expect(h.cpp.uploads).toHaveLength(0)
    }),
  )

  it.effect("answers a picture CPP did not take, without calling the tool", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(`${tmp.path}/after.png`, png))
      const h = yield* setup({ list: taskList, directory: tmp.path })
      yield* Effect.promise(() => h.cpp.server.stop(true))
      const failed = yield* h.failure("task", { id: "t1", pictures: ["after.png"] })
      expect(failed.message).toStartWith("Not sent: after.png could not be uploaded (")
      expect(h.cpp.calls()).toHaveLength(0)
    }),
  )
})

// The picture review end to end against a real CLIProxyPacer (the workspace's docs/reference/review-api.md), run by
// hand: CPP_LIVE=<origin> CPP_LIVE_KEY=<client key> [CPP_LIVE_PICTURES=<folder with after.png, before.png, more.png>]
// [CPP_LIVE_TASK=<a task denied in review: read it, then give its next round>]. The plugin and PacerTools are the real
// ones over HTTP; only the model is left out: these are the calls a model writes.
const LIVE = process.env.CPP_LIVE
describe.skipIf(!LIVE)("PacerToolsPlugin files, live", () => {
  const lead = SessionInfo.Info.make({ ...info, id: SessionInfo.ID.make("ses_pacer_review_live"), parentID: undefined })
  // the chat's project as a real step names it (PacerProject's headers for the session's project)
  const liveStep = {
    sessionID: lead.id,
    model: "claude-haiku-5-5",
    agent: "build",
    codemode: true,
    step: true,
    continues: false,
    project: { "X-Pacer-Project": String(lead.projectID) },
  }
  const liveSetup = Effect.fnUntraced(function* (directory: string) {
    const started = yield* startTools(endpointOf(LIVE!, process.env.CPP_LIVE_KEY), catalogOf(true), undefined, {})
    const chat = { current: lead }
    const context = yield* Layer.build(
      AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode]), [
        Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
        PacerTools.node.replace(Layer.succeed(PacerTools.Service, started.tools)),
        Session.node.replace(sessionsOf(chat)),
        Image.node.replace(imagePassthrough),
        locationNode(directory),
      ]),
    )
    const registry = Context.get(context, Tool.Service)
    yield* started.tools.list(liveStep)
    yield* until("task registered", () => Effect.runSync(names(registry)).includes("task"))
    const call = { sessionID: lead.id, ...toolIdentity }
    const run = (input: unknown) =>
      registry.snapshot().pipe(
        Effect.flatMap((tools) =>
          tools.execute({ ...call, call: { type: "tool-call", id: "call-task", name: "task", input } }),
        ),
        Effect.map((done) => ({
          ok: true as const,
          text: textOf(done),
        })),
        Effect.catch((error) =>
          Effect.succeed({ ok: false as const, text: String((error as { message?: unknown }).message ?? error) }),
        ),
      )
    return { run }
  })
  /** A tool result's text, whatever shape its content has (a string, a part, or parts). */
  const textOf = (done: unknown): string => {
    const content = (done as { content?: unknown }).content ?? (done as { output?: unknown }).output ?? done
    if (typeof content === "string") return content
    if (Array.isArray(content)) return content.map(textOf).join("\n")
    if (content && typeof content === "object" && "text" in content) return String((content as { text: unknown }).text)
    if (content && typeof content === "object" && "value" in content)
      return textOf((content as { value: unknown }).value)
    return JSON.stringify(content)
  }
  const pictures = async (dir: string) => {
    const from = process.env.CPP_LIVE_PICTURES
    const tiny = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    )
    for (const [name, extra] of [
      ["after.png", 0],
      ["before.png", 1],
      ["more.png", 2],
    ] as const)
      await Bun.write(
        `${dir}/${name}`,
        from ? Bun.file(`${from}/${name}`) : Buffer.concat([tiny, Buffer.from([extra])]),
      )
  }

  // it.effect, not it.live: the helpers wait with the test clock; the HTTP is real
  it.effect(
    "a task with pictures reaches CPP: uploaded, in review, refused done for an agent",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* Effect.promise(() => pictures(tmp.path))
        const h = yield* liveSetup(tmp.path)
        const said = (label: string, a: { ok: boolean; text: string }) =>
          console.log(`--- ${label} (${a.ok ? "ok" : "refused"})\n${a.text}`)
        const task = process.env.CPP_LIVE_TASK
        if (task) {
          const read = yield* h.run({ id: task })
          said("read after the verdict", read)
          expect(read.text).toContain("Review round 1")
          const next = yield* h.run({
            id: task,
            state: "review",
            pictures: [["after.png", "before.png", "Round 2: the notes taken"], "more.png"],
          })
          said("round 2", next)
          expect(next.ok).toBe(true)
          return
        }
        const made = yield* h.run({
          // a title of its own each run: CPP refuses a second task of the same title
          title: `Live picture review check ${new Date().toISOString().slice(11, 19)}`,
          subtasks: [{ title: "Make the pictures" }],
        })
        said("made", made)
        const id = /task ([a-z0-9]{12})/.exec(made.text)?.[1]
        const step = /subtask ([a-z0-9]{12})/.exec(made.text)?.[1]
        expect(id && step).toBeTruthy()
        said("step done", yield* h.run({ id: step, state: "done" }))
        const given = yield* h.run({
          id,
          pictures: [["after.png", "before.png", "Overview: the port beside the mockup"], "more.png"],
        })
        said("pictures", given)
        expect(given.ok).toBe(true)
        const missing = yield* h.run({ id, pictures: ["nothing-here.png"] })
        said("a missing file", missing)
        expect(missing.text).toStartWith("Not sent: nothing-here.png")
        const done = yield* h.run({ id, state: "done" })
        said("an agent's done", done)
        expect(done.ok).toBe(false)
        console.log(`LIVE_TASK=${id}`)
      }),
    120_000,
  )
})
