import { describe, expect } from "bun:test"
import { type LanguageModel, ToolDefinition } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAICompatibleChat, OpenAICompatibleResponses } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/testing"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Context, DateTime, Effect, Layer, SubscriptionRef } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Permission } from "@opencode/core/permission"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session as Sessions } from "@opencode/core/session"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Tool } from "@opencode/core/tool"
import { PacerWebTools } from "@opencode/core/tool/plugin/pacer-web"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { registerToolPlugin, toolIdentity } from "./lib/tool"
import { catalogOf, endpointOf, fakeCpp, ownerList, startTools } from "./pacer/fake-tools"
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

/** SessionModelRequest with PacerTools over a fake CPP. */
const setup = Effect.fnUntraced(function* (webTools = true) {
  const cpp = yield* fakeCpp
  const started = yield* startTools(endpointOf(cpp.origin), catalogOf(webTools))
  const requests = yield* SessionModelRequest.Service.pipe(
    Effect.provide(SessionModelRequest.layer),
    Effect.provideService(SessionModelTransport.Service, transport),
    Effect.provideService(PacerTools.Service, started.tools),
  )
  const input = (tools: Tool.Snapshot, model: string | LanguageModel = "claude-haiku-5-5") => ({
    session,
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

  it.effect("follows the catalog: a CPP whose capabilities drop the web tools is offered none", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      expect(names(yield* h.requests.primary(h.input(snapshot(all))))).toContain("web_search")
      yield* SubscriptionRef.set(h.catalogs, catalogOf(false))
      expect(names(yield* h.requests.primary(h.input(snapshot(all))))).toEqual(["read", "webfetch", "websearch"])
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
  Object.keys(prepared.request.http?.headers ?? {}).filter((name) => /^x-pacer-/i.test(name))

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
  name: "test/model-request-pacer-web-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(PacerWebTools.Plugin)),
  deps: [Tool.node, Permission.node, PacerEndpoint.node, PacerTools.node, Sessions.node],
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
        expect(prepared[0]?.request.http?.headers).toMatchObject({
          "x-opencode-session-id": session.id,
          "x-opencode-parent-session-id": parentID,
        })
      }
      // The same chat on CPP's own provider gets them: what this test tells apart.
      expect(pacerHeaders(yield* h.requests.primary(h.input(snapshot(all))))).toEqual([
        "X-Pacer-Session",
        "X-Pacer-Parent-Session",
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
