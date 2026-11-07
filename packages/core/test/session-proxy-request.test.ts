import { describe, expect, test } from "bun:test"
import { LanguageModel, LLMEvent } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionProxyRequest } from "@opencode/core/session/proxy-request"
import { createLLMEventPublisher } from "@opencode/core/session/runner/publish-llm-event"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// CLIProxyPacer's own form: `<yyyymmddhhmmss>-<auth_index, 16 hex digits>-<request ID, a UUID v7>`.
const requestID = "019a5c3e-8f21-7b40-9c2d-4e5f60718293"
const trace = `20261105141230-3f9a1c0b7d2e4a68-${requestID}`

const answer = (request: HttpClientRequest.HttpClientRequest, headers: Record<string, string> = {}) =>
  HttpClientResponse.fromWeb(request, new Response("{}", { status: 200, headers }))

describe("SessionProxyRequest.requestID", () => {
  test("takes the request ID out of CLIProxyPacer's trace ID", () => {
    expect(SessionProxyRequest.requestID(trace)).toBe(requestID)
    expect(SessionProxyRequest.requestID(trace.toUpperCase())).toBe(requestID)
  })

  test("keeps the request ID when the account part holds dashes", () => {
    expect(SessionProxyRequest.requestID(`20261105141230-home-a-b-${requestID}`)).toBe(requestID)
  })

  test("reads nothing from a missing or foreign value", () => {
    expect(SessionProxyRequest.requestID(undefined)).toBeUndefined()
    expect(SessionProxyRequest.requestID("")).toBeUndefined()
    expect(SessionProxyRequest.requestID(requestID)).toBeUndefined()
    expect(SessionProxyRequest.requestID(`20261105-3f9a1c0b7d2e4a68-${requestID}`)).toBeUndefined()
    expect(SessionProxyRequest.requestID("20261105141230-3f9a1c0b7d2e4a68-not-a-uuid")).toBeUndefined()
  })
})

describe("SessionProxyRequest.capture", () => {
  test("keeps the latest answer's request ID and passes the request on as it is", async () => {
    const sent: HttpClientRequest.HttpClientRequest[] = []
    const proxy = SessionProxyRequest.capture(undefined)
    const request = HttpClientRequest.post("https://proxy.test/v1/chat/completions")
    expect(proxy.current()).toBeUndefined()

    await Effect.runPromise(
      proxy.http(request, (input) => Effect.sync(() => (sent.push(input), answer(input, { "X-CPA-Trace-Id": trace })))),
    )
    expect(sent).toEqual([request])
    expect(proxy.current()).toBe(requestID)

    await Effect.runPromise(proxy.http(request, (input) => Effect.succeed(answer(input))))
    expect(proxy.current()).toBeUndefined()
  })

  test("reads the provider's own answer, inside the hooks", async () => {
    const proxy = SessionProxyRequest.capture((request, handler) =>
      handler(request).pipe(Effect.map((response) => answer(response.request, { "x-cpa-trace-id": "rewritten" }))),
    )
    const response = await Effect.runPromise(
      proxy.http(HttpClientRequest.post("https://proxy.test/v1/chat/completions"), (input) =>
        Effect.succeed(answer(input, { "x-cpa-trace-id": trace })),
      ),
    )
    expect(response.headers["x-cpa-trace-id"]).toBe("rewritten")
    expect(proxy.current()).toBe(requestID)
  })

  test("hands each answer's X-Pacer-Tools on, and undefined for an answer without it", async () => {
    const versions: Array<string | undefined> = []
    const proxy = SessionProxyRequest.capture(undefined, (version) => versions.push(version))
    const request = HttpClientRequest.post("https://proxy.test/v1/messages")
    await Effect.runPromise(
      proxy.http(request, (input) => Effect.succeed(answer(input, { "X-Pacer-Tools": "3f9a1c0b7d2e4a68" }))),
    )
    await Effect.runPromise(proxy.http(request, (input) => Effect.succeed(answer(input))))
    expect(versions).toEqual(["3f9a1c0b7d2e4a68", undefined])
  })
})

const session = Session.Info.make({
  id: Session.ID.make("ses_proxy_request"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const native = OpenAIChat.route.model({ id: "claude-opus-5-5", provider: "cliproxypacer" })
const resolved = (model: typeof native) =>
  SessionRunnerModel.resolved(model, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})
const prepare = (model: typeof native) =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service
    return yield* requests.primary({
      session,
      agent: Agent.ID.make("build"),
      model: resolved(model),
      system: [],
      messages: [],
    })
  }).pipe(Effect.provide(SessionModelRequest.layer), Effect.provideService(SessionModelTransport.Service, transport))

describe("SessionModelRequest proxy request ID", () => {
  const it = testEffect(PluginTestLayer)

  it.effect("reads it from each answer on a native HTTP route", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare(native)
      const http = prepared.options.http
      if (!http || !prepared.proxyRequestID) throw new Error("Expected the proxy capture on a native route")
      expect(prepared.proxyRequestID()).toBeUndefined()
      yield* http(HttpClientRequest.post("https://proxy.test/v1/chat/completions"), (request) =>
        Effect.succeed(answer(request, { "x-cpa-trace-id": trace })),
      )
      expect(prepared.proxyRequestID()).toBe(requestID)
    }),
  )

  it.effect("adds nothing on the AI SDK route, where middleware copies the body", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare(LanguageModel.update(native, { route: { ...native.route, protocol: "ai-sdk" } }))
      expect(prepared.options.http).toBeUndefined()
      expect(prepared.proxyRequestID).toBeUndefined()
    }),
  )

  it.effect("still runs the plugin HTTP hooks around it", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      yield* hooks.register("session", "http.response", () => Effect.sync(() => void seen.push("response")))
      const prepared = yield* prepare(native)
      yield* prepared.options.http!(HttpClientRequest.post("https://proxy.test/v1/chat/completions"), (request) =>
        Effect.succeed(answer(request, { "x-cpa-trace-id": trace })),
      )
      expect(seen).toEqual(["response"])
      expect(prepared.proxyRequestID?.()).toBe(requestID)
    }),
  )
})

const stepSessionID = Session.ID.make("ses_proxy_request_step")
const projected = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)

projected.effect("the step's message keeps the request ID of its latest attempt", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* database.db
      .insert(SessionTable)
      .values({
        id: stepSessionID,
        project_id: Project.ID.global,
        slug: "proxy",
        directory: "/project",
        version: "test",
      })
      .run()
    const assistantMessageID = SessionMessage.ID.create()
    const attempt = (id: string | undefined) => {
      const seen: { id?: string } = {}
      const publisher = createLLMEventPublisher(bus, {
        sessionID: stepSessionID,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model: { id: Model.ID.make("claude-opus-5-5"), providerID: Provider.ID.opencode },
        providerMetadataKey: "openai",
        started: 0,
        proxyRequestID: () => seen.id,
      })
      // The answer's headers arrive after the publisher is made and before the step starts.
      seen.id = id
      return publisher.publish(LLMEvent.stepStart({ index: 0 }))
    }
    const stored = database.db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .get()
      .pipe(Effect.map((row) => row?.data))

    yield* attempt(requestID)
    expect(yield* stored).toMatchObject({ proxyRequestID: requestID })
    const retried = "019a5c3f-0000-7000-8000-000000000001"
    yield* attempt(retried)
    expect(yield* stored).toMatchObject({ proxyRequestID: retried })
    yield* attempt(undefined)
    expect(yield* stored).not.toHaveProperty("proxyRequestID")
  }),
)
