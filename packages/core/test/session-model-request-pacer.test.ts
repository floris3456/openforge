import { describe, expect } from "bun:test"
import { ToolDefinition } from "@opencode/ai/effect"
import { AnthropicMessages } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/testing"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect, SubscriptionRef } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { Location } from "@opencode/core/location"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerTools } from "@opencode/core/pacer/tools"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import type { Tool } from "@opencode/core/tool"
import { testEffect } from "./lib/effect"
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
const resolved = (id: string) =>
  SessionRunnerModel.resolved(AnthropicMessages.route.model({ id, provider: "cliproxypacer" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
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
  const input = (tools: Tool.Snapshot, model = "claude-haiku-5-5") => ({
    session,
    agent: Agent.ID.make("build"),
    model: resolved(model),
    tools,
    system: [],
    messages: [],
  })
  return { cpp, requests, input, catalogs: started.catalogs }
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

  it.effect("follows the catalog: a CPP whose capabilities drop the web tools is offered none", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      expect(names(yield* h.requests.primary(h.input(snapshot(all))))).toContain("web_search")
      yield* SubscriptionRef.set(h.catalogs, catalogOf(false))
      expect(names(yield* h.requests.primary(h.input(snapshot(all))))).toEqual(["read", "webfetch", "websearch"])
    }),
  )
})
