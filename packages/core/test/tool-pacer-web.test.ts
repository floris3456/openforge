import { describe, expect } from "bun:test"
import { Context, Effect, Layer, SubscriptionRef } from "effect"
import { Money } from "@opencode/schema/money"
import { Session as SessionInfo } from "@opencode/schema/session"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { PacerWebTools } from "@opencode/core/tool/plugin/pacer-web"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime } from "effect"
import { testEffect } from "./lib/effect"
import { locationNode } from "./fixture/location"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"
import { endpointOf, fakeCpp, startTools, until } from "./pacer/fake-tools"

const parentID = SessionInfo.ID.make("ses_pacer_web_parent")
const sessionID = SessionInfo.ID.make("ses_pacer_web_child")
const info = SessionInfo.Info.make({
  id: sessionID,
  parentID,
  projectID: Project.ID.make("4b825dc642cb6eb9a060e54bf8d69288fbee4904"),
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})

/** The store's answer for the chat: a subagent, whose calls name its parent. */
const sessions = Layer.mock(Session.Service, {
  get: () => Effect.succeed(info),
  revert: {
    stage: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
    commit: () => Effect.die("unused"),
  },
})

const pluginNode = makeLocationNode({
  name: "test/pacer-web-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(PacerWebTools.Plugin)),
  deps: [Tool.node, Permission.node, PacerEndpoint.node, PacerTools.node, PacerProject.node, Session.node],
})

const it = testEffect(Layer.empty)

/** The real registry with the plugin, over a fake CPP: the endpoint in the test's hands, every permission ask kept. */
const setup = Effect.fnUntraced(function* (set = true) {
  const cpp = yield* fakeCpp
  const started = yield* startTools(set ? endpointOf(cpp.origin) : undefined)
  const asked: Array<Permission.AssertInput & { readonly calls: number }> = []
  const context = yield* Layer.build(
    AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode]), [
      Permission.node.replace(
        permissionLayer({
          assert: (input) => Effect.sync(() => void asked.push({ ...input, calls: cpp.calls().length })),
        }),
      ),
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
      Session.node.replace(sessions),
      Image.node.replace(imagePassthrough),
      locationNode("/project"),
    ]),
  )
  const registry = Context.get(context, Tool.Service)
  const run = (name: string, input: unknown) =>
    executeTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: `call-${name}`, name, input } })
  /** The failure itself, with its metadata, which the test helper leaves out. */
  const failure = (name: string, input: unknown) =>
    registry.snapshot().pipe(
      Effect.flatMap((tools) =>
        tools.execute({ sessionID, ...toolIdentity, call: { type: "tool-call", id: `call-${name}`, name, input } }),
      ),
      Effect.flip,
    )
  return { cpp, registry, tools: started.tools, endpoints: started.endpoints, asked, run, failure }
})

const names = (registry: Tool.Interface, permissions?: Permission.Ruleset) =>
  toolDefinitions(registry, permissions).pipe(Effect.map((items) => items.map((item) => item.name)))
const web = ["web_crawl", "web_extract", "web_research", "web_search"]

describe("PacerWebTools registration", () => {
  it.effect("registers the four as direct tools while CPP is set up, and follows the endpoint", () =>
    Effect.gen(function* () {
      const h = yield* setup(false)
      expect(yield* names(h.registry)).toEqual(["execute"])

      yield* SubscriptionRef.set(h.endpoints, endpointOf(h.cpp.origin))
      let listed: ReadonlyArray<string> = []
      yield* until("registered", () => {
        listed = Effect.runSync(names(h.registry))
        return listed.length > 1
      })
      // Direct, beside Code Mode's `execute`, not inside it.
      expect(listed).toEqual([...web, "execute"])

      yield* SubscriptionRef.set(h.endpoints, undefined)
      yield* until("removed", () => Effect.runSync(names(h.registry)).length === 1)
    }),
  )

  it.effect("registers the four when the endpoint arrives between the plugin's first read and its subscription", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const started = yield* startTools(endpointOf(cpp.origin))
      // `get` still answers from before the endpoint was set; `changes` already has it, as a SubscriptionRef replays
      // its latest value to a new subscriber.
      const context = yield* Layer.build(
        AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode]), [
          Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
          PacerEndpoint.node.replace(
            Layer.succeed(
              PacerEndpoint.Service,
              PacerEndpoint.Service.of({
                get: () => Effect.succeed(undefined),
                changes: () => SubscriptionRef.changes(started.endpoints),
              }),
            ),
          ),
          PacerTools.node.replace(Layer.succeed(PacerTools.Service, started.tools)),
          Session.node.replace(sessions),
          Image.node.replace(imagePassthrough),
          locationNode("/project"),
        ]),
      )
      const registry = Context.get(context, Tool.Service)
      yield* until("registered", () => Effect.runSync(names(registry)).length > 1)
      expect(yield* names(registry)).toEqual([...web, "execute"])
    }),
  )

  it.effect(
    "keeps the four through rebuilds of the registry, as a model update's reload, while the endpoint stays",
    () =>
      Effect.gen(function* () {
        const h = yield* setup()
        expect(yield* names(h.registry)).toEqual([...web, "execute"])
        // The same endpoint again, as each of its readers' first value after a reconnect.
        yield* SubscriptionRef.set(h.endpoints, endpointOf(h.cpp.origin))
        for (let index = 0; index < 3; index++) {
          yield* h.registry.reload()
          expect(yield* names(h.registry)).toEqual([...web, "execute"])
        }
      }),
  )

  it.effect("leaves out the tools whose permission an agent denies, as it does upstream's", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const deny = (action: string): Permission.Ruleset => [{ action, resource: "*", effect: "deny" }]
      expect(yield* names(h.registry, deny("websearch"))).toEqual(["web_crawl", "web_extract", "execute"])
      expect(yield* names(h.registry, deny("webfetch"))).toEqual(["web_research", "web_search", "execute"])
      // A rule on a resource governs calls, not whether the tool is offered.
      expect(yield* names(h.registry, [{ action: "websearch", resource: "*.example", effect: "deny" }])).toEqual([
        ...web,
        "execute",
      ])
    }),
  )
})

describe("PacerWebTools calls", () => {
  it.effect("asks as websearch with the query or question, as webfetch with the URLs, and with a job's id", () =>
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
      expect(h.asked[0]).toMatchObject({
        sessionID,
        agent: toolIdentity.agent,
        save: ["*"],
        metadata: calls[0][1],
        source: { type: "tool", messageID: toolIdentity.messageID, id: "call-web_search" },
      })
      // Each asked before its call went out; each call is a row of the chat, under its parent.
      expect(h.asked.map((item) => item.calls)).toEqual([0, 1, 2, 3, 4, 5])
      expect(h.cpp.calls().map((item) => [item.path, item.body])).toEqual(
        calls.map(([name, input]) => [`/pacer/v1/tools/${name}`, JSON.stringify(input)]),
      )
      for (const call of h.cpp.calls()) {
        expect(call.headers.get("x-pacer-session")).toBe(PacerSessionID.make(sessionID))
        expect(call.headers.get("x-pacer-parent-session")).toBe(PacerSessionID.make(parentID))
        // And its project, named by the location's folder.
        expect(call.headers.get("x-pacer-project")).toBe(info.projectID)
        expect(call.headers.get("x-pacer-project-name")).toBe("project")
      }
    }),
  )

  it.effect("calls nothing when the permission is denied", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const started = yield* startTools(endpointOf(cpp.origin))
      const context = yield* Layer.build(
        AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode]), [
          Permission.node.replace(
            permissionLayer({
              assert: (input) =>
                new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }),
            }),
          ),
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
          Session.node.replace(sessions),
          Image.node.replace(imagePassthrough),
          locationNode("/project"),
        ]),
      )
      const result = yield* executeTool(Context.get(context, Tool.Service), {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-denied", name: "web_search", input: { query: "q" } },
      })
      expect(result).toMatchObject({
        status: "error",
        error: { type: "permission.rejected", message: "Permission denied: websearch" },
      })
      expect(cpp.calls()).toHaveLength(0)
    }),
  )

  it.effect("gives the model CPP's text, and the chat the service that served it and the job while one runs", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const answers = [
        { provider: "youcom", shown: { provider: "You.com" } },
        { provider: "chatgpt", shown: { provider: "ChatGPT" } },
        { provider: "newsearch", shown: { provider: "newsearch" } },
        { provider: "", shown: {} },
      ]
      for (const answer of answers) {
        h.cpp.answers.call = () =>
          Response.json({
            text: "1. Rust 1.95 …",
            data: { tool: "web_search", provider: answer.provider },
            error: null,
          })
        expect(yield* h.run("web_search", { query: "q" })).toEqual({
          status: "completed",
          content: [{ type: "text", text: "1. Rust 1.95 …" }],
          metadata: answer.shown,
        })
      }

      h.cpp.answers.call = () =>
        Response.json({
          text: 'Web research: started "q"; it takes longer than one call (job job_0123456789abcdef0123456789abcdef).',
          data: {
            tool: "web_research",
            job_id: "job_0123456789abcdef0123456789abcdef",
            status: "running",
            provider: "exa",
          },
          error: null,
        })
      expect((yield* h.run("web_research", { question: "q" })).metadata).toEqual({
        provider: "Exa",
        job: { id: "job_0123456789abcdef0123456789abcdef", status: "running" },
      })
    }),
  )
})

// CLIProxyPacer, step 2, section 3: what CPP answers, and what the tool call does.
describe("PacerWebTools answers", () => {
  it.effect("200 without error: succeeds with CPP's text", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      expect(yield* h.run("web_extract", { urls: ["https://a.example/"] })).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "answered /pacer/v1/tools/web_extract" }],
        metadata: { provider: "Tavily" },
      })
    }),
  )

  it.effect("200 with error: fails with CPP's text, which tells the model to go on without it", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const text = "Web search failed: the query is mostly a secret, so it was not sent. Go on without it."
      h.cpp.answers.call = () =>
        Response.json({
          text,
          data: { tool: "web_search" },
          error: { code: "secret_query", message: "the query is mostly a secret, so it was not sent" },
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
          { error: { type: "invalid_request", message: "web_search has no mode; invalid max_results" } },
          {
            status: 400,
          },
        )
      expect(yield* h.run("web_search", { query: "q", mode: "x", max_results: 50 })).toMatchObject({
        status: "error",
        error: {
          type: "tool.execution",
          message: "CLIProxyPacer refused the arguments of web_search: web_search has no mode; invalid max_results",
        },
      })
    }),
  )

  it.effect("404: fails, and the chat's list is read again at its next request", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const step = { sessionID, parentID, model: "claude-haiku-5-5", step: true, continues: false }
      yield* h.tools.list(step)
      h.cpp.answers.call = () =>
        Response.json({ error: { type: "not_found", message: "no tool web_crawl" } }, { status: 404 })
      expect(yield* h.run("web_crawl", { url: "https://a.example/" })).toMatchObject({
        status: "error",
        error: { type: "tool.execution", message: "CLIProxyPacer has no tool web_crawl" },
      })
      yield* h.tools.list(step)
      expect(h.cpp.lists()).toHaveLength(2)
    }),
  )

  it.effect("unreachable or refused: fails, saying CPP could not be reached", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const closed = h.cpp.origin
      yield* Effect.promise(() => h.cpp.server.stop(true))
      yield* SubscriptionRef.set(h.endpoints, endpointOf(closed, "client-key-closed"))
      const result = yield* h.run("web_search", { query: "q" })
      expect(result.status).toBe("error")
      expect(result.error?.message).toStartWith("CLIProxyPacer could not be reached: ")
    }),
  )
})
