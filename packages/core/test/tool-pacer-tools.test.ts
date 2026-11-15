import { describe, expect } from "bun:test"
import { ToolDefinition } from "@opencode/ai/effect"
import { Context, DateTime, Effect, Layer, SubscriptionRef } from "effect"
import { Money } from "@opencode/schema/money"
import { Session as SessionInfo } from "@opencode/schema/session"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { PacerToolsPlugin } from "@opencode/core/tool/plugin/pacer-tools"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { locationNode } from "./fixture/location"
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
  deps: [Tool.node, Permission.node, PacerTools.node, PacerProject.node, Session.node],
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
const step = { sessionID, parentID, model: "claude-haiku-5-5", step: true, continues: false }

/** The real registry with the plugin, over a fake CPP whose list the chat has read once. */
const setup = Effect.fnUntraced(function* (
  options: { readonly read?: boolean; readonly catalog?: PacerModels.Catalog } = {},
) {
  const cpp = yield* fakeCpp
  cpp.answers.list = () => Response.json(listed)
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
      locationNode("/project"),
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
      // Not offered directly: as any tool the request doesn't hold.
      const refused = yield* snapshot
        .execute({ sessionID, ...toolIdentity, call, definitions: new Map() })
        .pipe(Effect.flip)
      expect(refused.message).toContain('No tool named "moon_phase"')
    }),
  )
})
