import { afterAll, expect } from "bun:test"
import { type LanguageModel } from "@opencode/ai/effect"
import { OpenAICompatibleResponses } from "@opencode/ai/providers"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { ServiceClient } from "@opencode/core/service-client"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSummaries } from "@opencode/core/pacer/summaries"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "../lib/effect"

// Synthetic: no real address or key.
const key = "k-compact-pair"
const summary = "## Objective\n- the summary the second instance wrote"

/**
 * One instance of CPP's pair on a local server, recording each path it is asked for. `down` answers every request 502,
 * as the tunnel does while the instance is away; up, `/v1/responses` streams a summary.
 */
const instance = () => {
  const state = { down: false, paths: [] as string[] }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url)
      state.paths.push(url.pathname)
      if (state.down) return new Response("bad gateway", { status: 502 })
      if (url.pathname !== "/v1/responses") return new Response("not found", { status: 404 })
      return new Response(
        [
          { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
          { type: "response.output_text.delta", item_id: "msg_1", delta: summary },
          { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 400, output_tokens: 20 } } },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const root = `http://127.0.0.1:${server.port}`
  return { state, server, root, address: { ...PacerEndpoint.normalize(root)! } }
}
const a = instance()
const b = instance()
const one = instance()
afterAll(() => [a, b, one].forEach((item) => item.server.stop(true)))

/**
 * Where CPP is: the set-up address `a` and its peer `b`, as capabilities name them, or only `one` (an older server).
 * An outage moves to the other address while it is up, as `PacerEndpoint.failover` does.
 */
const pair = {
  addresses: [a.address, b.address],
  current: a.address as PacerEndpoint.Address,
  moves: 0,
}
const home = () => PacerEndpoint.resolve({ baseURL: pair.addresses[0]!.baseURL, apiKey: key }, undefined)!
const endpoints = PacerEndpoint.Service.of({
  get: () =>
    Effect.sync(() => (pair.current.root === home().root ? home() : { ...home(), ...pair.current, home: home().root })),
  changes: () => Stream.never,
  addresses: () => Effect.sync(() => pair.addresses),
  failover: () =>
    Effect.sync(() => {
      const next = pair.addresses.find(
        (address) =>
          address.root !== pair.current.root && ![a, b, one].find((item) => item.root === address.root)?.state.down,
      )
      if (!next) return false
      pair.current = next
      pair.moves++
      return true
    }),
})

const resolved = (model: LanguageModel) =>
  SessionRunnerModel.resolved(model, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
/** A model of CPP's as the provider pins it, at `root`. */
const pinnedAt = (root: string) =>
  resolved(
    OpenAICompatibleResponses.configure({ apiKey: key, baseURL: `${root}/v1`, provider: "cliproxypacer" }).model(
      "kimi-e2e",
    ),
  )

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
      llmClient,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      // The model client as the service runs it.
      llmClient.replace(ServiceClient.llm()),
      PacerEndpoint.node.replace(Layer.succeed(PacerEndpoint.Service, endpoints)),
      // A server without CPP's tools: no list read waits out the outage before the request (PacerTools.list).
      PacerModels.node.replace(
        Layer.succeed(
          PacerModels.Service,
          PacerModels.Service.of({
            get: () => Effect.succeed({ at: 0, pacer: { compactTokens: [], webTools: false }, models: [] }),
            changes: () => Stream.never,
            refresh: () => Effect.void,
          }),
        ),
      ),
      // openforge writes the summary itself, as an ordinary request of the chat.
      PacerSummaries.node.replace(
        Layer.succeed(
          PacerSummaries.Service,
          PacerSummaries.Service.of({ plan: () => Effect.succeed({ by: "openforge" }) }),
        ),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      SessionRunnerModel.node.replace(Layer.mock(SessionRunnerModel.Service)({ resolve: () => Effect.die("unused") })),
    ],
  ),
)

const user = (text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(0) },
  })
const assistant = (text: string, model: SessionRunnerModel.Resolved) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: model.ref,
    content: [{ type: "text", text }],
    tokens: { input: 2_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, completed: 1 },
  })

/** A stored chat of two exchanges on `model`, and the context a compaction of it gets. */
const chat = Effect.fnUntraced(function* (name: string, model: SessionRunnerModel.Resolved) {
  const id = Session.ID.make(`ses_compact_pair_${name}`)
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test" })
    .run()
    .pipe(Effect.orDie)
  const messages = [
    user("Plan a dark mode."),
    assistant("Here is a five-step plan.", model),
    user("Now list three risks."),
    assistant("Missed styles, contrast, preference behaviour.", model),
  ]
  yield* db
    .insert(SessionMessageTable)
    .values(
      messages.map((message, index) => {
        const { id: messageID, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
        return { id: SessionMessage.ID.make(messageID), session_id: id, type, seq: index + 1, time_created: 0, data }
      }),
    )
    .run()
    .pipe(Effect.orDie)
  yield* Bus.reserveSequence(db, id, messages.length)
  const session = yield* (yield* SessionStore.Service).get(id)
  if (!session) return yield* Effect.die(`session missing: ${id}`)
  return {
    session,
    messages,
    model,
    agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
    initial: [{ key: Instructions.Key.make("test/session"), text: "Session instructions" }],
    tools: { definitions: [], execute: () => Effect.die("Compaction must not execute tools") },
  }
})

const compacted = (context: Effect.Success<ReturnType<typeof chat>>) =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    return yield* compaction.compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } })
  })

const responses = (paths: ReadonlyArray<string>) => paths.filter((path) => path === "/v1/responses")

it.live("a compaction during an outage moves to the other instance and is written there at once", () =>
  Effect.gen(function* () {
    a.state.down = true
    // Without the move, the retry waits out ModelRetry's backoff at the first address for as long as the outage lasts.
    const result = yield* compacted(yield* chat("outage", pinnedAt(a.root))).pipe(Effect.timeout("5 seconds"))
    expect(result).toEqual({ status: "completed" })
    expect(pair.moves).toBe(1)
    expect(pair.current.root).toBe(b.root)
    expect(responses(a.state.paths)).toHaveLength(1)
    expect(responses(b.state.paths)).toHaveLength(1)
  }),
)

it.live("with one address (an older server), an outage moves nothing and the compaction waits as before", () =>
  Effect.gen(function* () {
    pair.addresses = [one.address]
    pair.current = one.address
    pair.moves = 0
    one.state.down = true
    const exit = yield* compacted(yield* chat("one", pinnedAt(one.root))).pipe(Effect.timeout("1 second"), Effect.exit)
    // Still waiting at its one address after the first 502: ModelRetry's backoff, not a move.
    expect(exit._tag).toBe("Failure")
    expect(pair.moves).toBe(0)
    expect(responses(one.state.paths)).toHaveLength(1)
  }),
)
