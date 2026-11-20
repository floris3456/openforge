import { expect, test } from "bun:test"
import {
  AIError,
  InvalidRequestError,
  LLMClient,
  LLMEvent,
  LanguageModel,
  Message,
  ToolDefinition,
  type LLMRequest,
} from "@opencode/ai/effect"
import { AnthropicMessages, OpenAIChat } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/testing"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { EventTable } from "@opencode/core/event/sql"
import { Instructions } from "@opencode/core/instructions/index"
import { SessionCompaction } from "@opencode/core/session/compaction"
import type { SessionContext } from "@opencode/core/session/context"
import { MessageDecodeError } from "@opencode/core/session/error"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Token } from "@opencode/core/util/token"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRecentText } from "@opencode/core/session/recent-text"
import { MemoryOffer } from "@opencode/core/memory/offer"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionThinkingBudget } from "@opencode/core/session/thinking-budget"
import { Session } from "@opencode/core/session"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { App } from "@opencode/core/app"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { Skill } from "@opencode/schema/skill"
import { Shell } from "@opencode/schema/shell"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { asc, eq, inArray, sql } from "drizzle-orm"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
/** Runs before a request's response streams; tests hold it back to keep a background summary in flight. */
let beforeResponse: Effect.Effect<void> = Effect.void
let reject: ((request: LLMRequest) => boolean) | undefined
const model = LanguageModel.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route,
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    if (reject?.(request)) {
      return Stream.fail(
        new AIError({
          reason: new InvalidRequestError({ message: "prompt too long", classification: "context-overflow" }),
        }),
      )
    }
    return Stream.fromEffect(beforeResponse).pipe(
      Stream.drain,
      Stream.concat(
        Stream.make(
          LLMEvent.textDelta({ id: "summary", text: "## Objective\n- manual summary" }),
          LLMEvent.stepFinish({
            index: 0,
            reason: { normalized: "stop" },
            usage: {
              inputTokens: 15,
              outputTokens: 6,
              nonCachedInputTokens: 10,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
              reasoningTokens: 2,
            },
          }),
          LLMEvent.finish({
            reason: { normalized: "stop" },
          }),
        ),
      ),
    )
  },
  generate: () => Effect.die("unused"),
})
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  cost,
  limit: { context: 200_000, output: 32_000 },
})
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
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt(false)

  expect(prompt).toContain("## Work State")
  expect(prompt).toContain("### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

it.effect("compaction describes tool media without embedding base64", () =>
  Effect.gen(function* () {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
    const recent = yield* recentWithToolOutput(Session.ID.make("ses_tool_media"), [
      { type: "text", text: "Image read successfully" },
      {
        type: "file",
        uri: `data:image/png;base64,${base64}`,
        mime: "image/png",
        name: "pixel.png",
      },
    ])

    expect(recent).toContain("[Tool result]: Image read successfully\n[Attached image/png: pixel.png]")
    expect(recent).not.toContain(base64)
  }),
)

it.effect("compaction truncation does not split surrogate pairs", () =>
  Effect.gen(function* () {
    const prefix = "a".repeat(1_249)
    const split = yield* recentWithToolOutput(Session.ID.make("ses_truncate_split"), [
      { type: "text", text: `${prefix}😀suffix` },
    ])
    const whole = yield* recentWithToolOutput(Session.ID.make("ses_truncate_whole"), [
      { type: "text", text: "😀".repeat(1_250) },
    ])

    expect(split).toEndWith(`[Tool result]: ${prefix}😀\n[truncated]\n\n[Assistant]: Read.`)
    expect(whole).toEndWith(`[Tool result]: ${"😀".repeat(1_250)}\n\n[Assistant]: Read.`)
  }),
)

it.effect("summaries written before kept-message references keep their stored recent text", () =>
  Effect.gen(function* () {
    const id = Session.ID.make("ses_legacy_recent")
    yield* insertSession(id)
    yield* storeMessages(id, [textUser("Kept question")])
    const db = (yield* Database.Service).db
    // Stored before v2.1: the kept text sits in `recent`, with no reference.
    const legacy = {
      status: "completed" as const,
      reason: "auto" as const,
      summary: "## Objective\n- legacy",
      recent: "[User]: Kept question as flattened then",
      time: { created: 0 },
    }
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.create(),
        session_id: id,
        type: "compaction",
        seq: 2,
        time_created: 0,
        data: legacy,
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    const [compaction] = yield* store.context(id)
    expect(compaction).toMatchObject({
      type: "compaction",
      metadata: { recent: "[User]: Kept question as flattened then" },
    })
    expect(compaction).not.toHaveProperty("recent")
  }),
)

it.effect("forks rebuild the recent text of a summary they copied", () =>
  Effect.gen(function* () {
    const parentID = Session.ID.make("ses_fork_recent_parent")
    const childID = Session.ID.make("ses_fork_recent_child")
    const session = yield* insertSession(parentID)
    const messages = [textUser("Earlier question"), textUser("Kept question"), reply("Kept answer")]
    yield* storeMessages(parentID, messages)
    expect(yield* compactManually(session, messages)).toEqual({ status: "completed" })
    const store = yield* SessionStore.Service
    const [parent] = yield* store.context(parentID)
    const recent = "[User]: Kept question\n\n[Assistant]: Kept answer"
    expect(parent).toMatchObject({ type: "compaction", metadata: { recent } })

    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.Forked, {
      sessionID: childID,
      parentID,
      boundary: { type: "through", messageID: parent.id },
    })
    const [child] = yield* store.context(childID)
    expect(child).toMatchObject({ type: "compaction", metadata: { recent } })
    expect(child.metadata?.keepID).not.toBe(parent.metadata?.keepID)
  }),
)

it.effect("forks keep a summary's unread step and the messages it sends as themselves, under the fork's IDs", () =>
  Effect.gen(function* () {
    const parentID = Session.ID.make("ses_fork_unsent_parent")
    const childID = Session.ID.make("ses_fork_unsent_child")
    yield* insertSession(parentID)
    const asked = textUser("Read the file")
    const file = "export const value = 1\n".repeat(150)
    // Its tool settled after the request that called it: the model has not read the result.
    const unread = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [
        {
          type: "tool",
          id: "call_read",
          name: "read",
          state: { status: "completed", input: {}, content: [{ type: "text", text: file }] },
          time: { created: 0 },
        },
      ],
      time: { created: 0, completed: 1 },
    })
    // A prompt steered in after the step: the compaction sends it as itself.
    const prompt = textUser("Then fix it")
    const compaction = SessionMessage.CompactionCompleted.make({
      ...completedSummary("## Objective\n- Fix the file"),
      metadata: {
        keepID: asked.id,
        [SessionRecentText.UNREAD]: unread.id,
        [SessionRecentText.UNREAD_CHARS]: 10_000,
        [SessionRecentText.UNSENT]: prompt.id,
        [SessionRecentText.CUT_INPUTS]: "cut",
      },
    })
    yield* storeMessages(parentID, [asked, unread, prompt, compaction])
    const store = yield* SessionStore.Service
    const parent = yield* store.context(parentID)
    expect(parent.map((message) => message.type)).toEqual(["compaction", "user"])
    const recent = `[User]: Read the file\n\n[Assistant tool call]: read({})\n[Tool result]: ${file}`
    expect(parent[0]).toMatchObject({ metadata: { recent } })

    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.Forked, {
      sessionID: childID,
      parentID,
      boundary: { type: "through", messageID: compaction.id },
    })
    const child = yield* store.context(childID)
    expect(child.map((message) => message.type)).toEqual(["compaction", "user"])
    expect(child[0]).toMatchObject({ metadata: { recent } })
    expect(child[1]).toMatchObject({ type: "user", text: "Then fix it" })
    expect(child[1]?.id).not.toBe(prompt.id)
    for (const key of [SessionRecentText.UNREAD, SessionRecentText.UNSENT])
      expect(child[0]?.metadata?.[key]).not.toBe(parent[0]?.metadata?.[key])
  }),
)

it.effect("ignores non-message keepID strings when loading history or forking", () =>
  Effect.gen(function* () {
    const parentID = Session.ID.make("ses_invalid_keepid_parent")
    const childID = Session.ID.make("ses_invalid_keepid_child")
    yield* insertSession(parentID)
    const compaction = SessionMessage.CompactionCompleted.make({
      id: SessionMessage.ID.create(),
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "## Objective\n- plugin summary",
      metadata: { keepID: "not-a-msg-id" },
      time: { created: DateTime.makeUnsafe(0) },
    })
    yield* storeMessages(parentID, [textUser("Earlier question"), compaction])

    const store = yield* SessionStore.Service
    const [parent] = yield* store.context(parentID)
    expect(parent).toMatchObject({
      type: "compaction",
      metadata: { keepID: "not-a-msg-id" },
    })

    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.Forked, {
      sessionID: childID,
      parentID,
      boundary: { type: "through", messageID: compaction.id },
    })
    const [child] = yield* store.context(childID)
    expect(child).toMatchObject({
      type: "compaction",
      metadata: { keepID: "not-a-msg-id" },
    })
  }),
)

it.effect("history from the latest completed compaction matches the full transcript cut there", () =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db
    const failed = SessionMessage.CompactionFailed.make({
      id: SessionMessage.ID.create(),
      type: "compaction",
      status: "failed",
      reason: "auto",
      error: { type: "unknown", message: "failed" },
      time: { created: DateTime.makeUnsafe(0) },
    })
    const scenarios = {
      none: [textUser("a"), textUser("b")],
      one: [textUser("a"), completedSummary("one"), textUser("b")],
      several: [textUser("a"), completedSummary("one"), textUser("b"), completedSummary("two"), textUser("c")],
      failed: [textUser("a"), completedSummary("one"), textUser("b"), failed, textUser("c")],
    }
    for (const [name, messages] of Object.entries(scenarios)) {
      const id = Session.ID.make(`ses_history_bound_${name}`)
      yield* insertSession(id)
      yield* storeMessages(id, messages)
      const all = yield* store.messages({ sessionID: id, order: "asc" })
      const start = Math.max(
        0,
        all.findLastIndex((message) => message.type === "compaction" && message.status === "completed"),
      )
      const history = yield* SessionHistory.load(db, id, resolved.ref)
      expect(toLLMMessages(history, resolved.ref)).toEqual(toLLMMessages(all.slice(start), resolved.ref))
    }
  }),
)

it.effect("history never decodes rows before the latest compaction or its kept tail", () =>
  Effect.gen(function* () {
    const id = Session.ID.make("ses_history_bound_kept")
    yield* insertSession(id)
    const kept = textUser("Kept question")
    const compaction = SessionMessage.CompactionCompleted.make({
      ...completedSummary("two"),
      metadata: { keepID: kept.id },
    })
    const tail = textUser("After")
    const earlier = [textUser("old 1"), completedSummary("one"), textUser("old 2")]
    yield* storeMessages(id, [...earlier, kept, compaction, tail])
    const db = (yield* Database.Service).db
    // Rows the model no longer sees, made undecodable: reading any of them would fail the load.
    yield* db
      .update(SessionMessageTable)
      .set({ data: sql`json('{}')` })
      .where(
        inArray(
          SessionMessageTable.id,
          earlier.map((message) => message.id),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    expect(yield* store.messages({ sessionID: id }).pipe(Effect.flip)).toBeInstanceOf(MessageDecodeError)

    const history = yield* SessionHistory.load(db, id, resolved.ref)
    expect(toLLMMessages(history, resolved.ref)).toEqual(
      toLLMMessages(
        [{ ...compaction, metadata: { keepID: kept.id, recent: "[User]: Kept question" } }, tail],
        resolved.ref,
      ),
    )
  }),
)

// Workspace evidence overnight-2026-11-15, recheck 1: a compaction came before any request carried the prompt, which then
// reached the model only in the checkpoint's recent part, as "historical context, not as new instructions".
it.effect("history sends what a compaction kept after the last reply as itself, only when the compaction says so", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const run = (marked: boolean) =>
      Effect.gen(function* () {
        const id = Session.ID.make(`ses_unsent_${marked ? "marked" : "unmarked"}`)
        yield* insertSession(id)
        const asked = textUser("Which paths have no tests?")
        const prompt = textUser("Write tests for the first three.")
        const entries = SessionMessage.Synthetic.make({
          id: SessionMessage.ID.create(),
          type: "synthetic",
          text: "Memory close to the prompt",
          time: { created: DateTime.makeUnsafe(0) },
        })
        // An instruction update, which the instructions after the compaction hold, and a step the provider turned down.
        const update = SessionMessage.System.make({
          id: SessionMessage.ID.create(),
          type: "system",
          text: "Instructions changed",
          time: { created: DateTime.makeUnsafe(0) },
        })
        const refused = Schema.decodeUnknownSync(SessionMessage.Assistant)({
          id: SessionMessage.ID.create(),
          type: "assistant",
          agent: Agent.defaultID,
          model: { id: "summary-model", providerID: "test" },
          content: [],
          time: { created: 0 },
        })
        const after = textUser("Go on")
        const compaction = SessionMessage.CompactionCompleted.make({
          ...completedSummary("## Objective\n- Find the untested paths"),
          metadata: { keepID: asked.id, ...(marked ? { [SessionRecentText.UNSENT]: prompt.id } : {}) },
        })
        yield* storeMessages(id, [
          asked,
          reply("Three paths have none."),
          prompt,
          entries,
          update,
          refused,
          compaction,
          after,
        ])
        return {
          ids: { compaction: compaction.id, prompt: prompt.id, entries: entries.id, after: after.id },
          history: yield* SessionHistory.load(db, id, resolved.ref),
          synthetics: yield* SessionHistory.synthetics(db, id),
        }
      })

    // Written before the marker: everything it kept is its recent part, as before.
    const unmarked = yield* run(false)
    expect(unmarked.history.map((message) => message.type)).toEqual(["compaction", "user"])
    expect(unmarked.history[0]).toMatchObject({
      metadata: {
        recent: [
          "[User]: Which paths have no tests?",
          "[Assistant]: Three paths have none.",
          "[User]: Write tests for the first three.",
          "[Synthetic context]: Memory close to the prompt",
        ].join("\n\n"),
      },
    })
    expect(unmarked.synthetics).toEqual([])

    const marked = yield* run(true)
    expect(marked.history.map((message) => message.id)).toEqual([
      marked.ids.compaction,
      marked.ids.prompt,
      marked.ids.entries,
      marked.ids.after,
    ])
    expect(marked.history[0]).toMatchObject({
      metadata: { recent: "[User]: Which paths have no tests?\n\n[Assistant]: Three paths have none." },
    })
    const sent = toLLMMessages(marked.history, resolved.ref)
    expect(sent.map((message) => message.role)).toEqual(["user", "user", "user", "user"])
    expect(JSON.stringify(sent[0])).not.toContain("Write tests")
    expect(sent.slice(1).map((message) => message.content)).toEqual([
      [{ type: "text", text: "Write tests for the first three." }],
      [{ type: "text", text: "Memory close to the prompt" }],
      [{ type: "text", text: "Go on" }],
    ])
    // The synthetic messages history sends, as instruction files' reminders are deduplicated against.
    expect(marked.synthetics.map((message) => message.id)).toEqual([marked.ids.entries])
  }),
)

// The size check before the step after the compaction: no step measured the prompt yet, so it is estimated, once.
it.effect("the prompt a compaction sends as itself counts once, as estimated, until a step measures it", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const id = Session.ID.make("ses_unsent_estimate")
    const session = yield* insertSession(id)
    const asked = textUser("Which paths have no tests?")
    const prompt = textUser("Write tests for the first three of those untested paths, each in a file of its own.")
    const compaction = SessionMessage.CompactionCompleted.make({
      ...completedSummary("## Objective\n- Find the untested paths"),
      metadata: { keepID: asked.id, [SessionRecentText.UNSENT]: prompt.id },
    })
    yield* storeMessages(id, [asked, reply("Three paths have none."), prompt, compaction])
    const history = yield* SessionHistory.load(db, id, resolved.ref)
    expect(history.map((message) => message.id)).toEqual([compaction.id, prompt.id])
    const [checkpoint] = history
    if (checkpoint?.type !== "compaction" || checkpoint.status !== "completed") throw new Error("expected a summary")
    expect(SessionRecentText.kept(checkpoint)).not.toContain(prompt.text)

    const estimate = SessionCompaction.estimatePrompt(loaded(session, history))
    const without = SessionCompaction.estimatePrompt(loaded(session, history.slice(0, 1)))
    expect(estimate.measured).toBe(0)
    // Before any measurement, prompt text is put at 2.5 characters a token.
    expect(estimate.estimated - without.estimated).toBe(Token.estimate(prompt.text, 2.5))
    // A step's count holds it from then on.
    expect(SessionCompaction.estimatePrompt(loaded(session, [...history, measured("On it.", 9_000)]))).toEqual({
      measured: 9_100,
      estimated: 0,
    })
  }),
)

// A block among them is in the model's view, so memory builds no second one after the compaction (spec memory, section 3).
it.effect("memory's start block among what a compaction sends as itself stays in view", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    for (const marked of [false, true]) {
      const id = Session.ID.make(`ses_unsent_block_${marked ? "marked" : "unmarked"}`)
      yield* insertSession(id)
      const prompt = textUser("Fix the typo")
      const block = SessionMessage.Synthetic.make({
        id: SessionMessage.ID.create(),
        type: "synthetic",
        text: "Memory: nothing yet",
        metadata: { memory: { project: "prj", entries: [], tasks: false } },
        time: { created: DateTime.makeUnsafe(0) },
      })
      const compaction = SessionMessage.CompactionCompleted.make({
        ...completedSummary("## Objective\n- Fix the typo"),
        metadata: { keepID: prompt.id, ...(marked ? { [SessionRecentText.UNSENT]: prompt.id } : {}) },
      })
      yield* storeMessages(id, [textUser("Earlier"), reply("Done"), prompt, block, compaction])
      expect((yield* MemoryOffer.newestBlock(db, id))?.visible).toBe(marked)
    }
  }),
)

const completedSummary = (summary: string) =>
  SessionMessage.CompactionCompleted.make({
    id: SessionMessage.ID.create(),
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary,
    time: { created: DateTime.makeUnsafe(0) },
  })

const textUser = (text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(0) },
  })

/**
 * The model's reply to the messages before it, so a request carried them: what comes after a chat's last reply is
 * sent after the summary as itself, never summarized (`SessionRecentText.UNSENT`).
 */
const reply = (text: string) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "summary-model", providerID: "test" },
    content: [{ type: "text", text }],
    time: { created: 0, completed: 1 },
  })

// openforge: the person's own words are kept after the summary by CLIProxyPacer's list of earlier messages, which no
// provider's compaction could keep; the summary is not asked to quote them (workspace spec
// `docs/specs/earlier-messages-kept.md`).
test("compaction prompt does not ask the summary to quote the user's requests word for word", () => {
  for (const prompt of [SessionCompaction.buildPrompt(false), SessionCompaction.buildPrompt(true)])
    expect(prompt).not.toContain("exact wording")
})

test("compaction prompt requires the checkpoint headings in order", () => {
  const prompt = SessionCompaction.buildPrompt(false)
  expect(prompt.match(/^#{2,3} .+$/gm)).toEqual([
    "## Objective",
    "## Requirements",
    "## Decisions",
    "## Work State",
    "### Completed",
    "### Active",
    "### Blocked",
    "## Next Move",
    "## Relevant Files",
    "## Important Context",
  ])
})

test("compaction update prompt rewrites legacy checkpoints only when asked", () => {
  const rewrite = "The existing checkpoint was written with an earlier format"
  expect(SessionCompaction.buildPrompt(true, true)).toContain(rewrite)
  expect(SessionCompaction.buildPrompt(true)).not.toContain(rewrite)
  expect(SessionCompaction.buildPrompt(false, true)).not.toContain(rewrite)
})

test("compaction prompts prohibit task execution", () => {
  for (const update of [false, true])
    expect(SessionCompaction.buildPrompt(update)).toContain("Do not continue the task or call tools")
})

it.effect("auto compaction estimates current content against the buffered prompt ceiling", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_input_limit"))
    const input = (tokens: number, limit: { context: number; input?: number; output: number }) => ({
      session,
      model: SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
        cost: [],
        limit,
      }),
      messages: [
        Schema.decodeUnknownSync(SessionMessage.Assistant)({
          id: SessionMessage.ID.make("msg_assistant"),
          type: "assistant",
          agent: Agent.defaultID,
          model: { id: "summary-model", providerID: "test" },
          content: [{ type: "text", text: "Done" }],
          tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, completed: 0 },
        }),
      ],
      agent: {
        id: Agent.defaultID,
        info: { ...Agent.Info.default(Agent.defaultID), system: "You are a helpful assistant." },
      },
      initial: [{ key: Instructions.Key.make("test/project"), text: "Project instructions." }],
      tools: {
        definitions: [
          ToolDefinition.make({ name: "read", description: "Read files", inputSchema: { type: "object" } }),
        ],
        execute: () => Effect.die("unused"),
      },
    })
    // An automatic compaction that is not due is skipped.
    const due = (context: SessionContext.Loaded, estimate?: SessionCompaction.Estimate) =>
      compaction
        .compact({ reason: "auto", context, estimate })
        .pipe(Effect.map((outcome) => outcome.status !== "skipped"))

    // 85% of the input limit, which takes precedence over the context window.
    const inputLimited = { context: 400_000, input: 272_000, output: 128_000 }
    expect(yield* due(input(231_199, inputLimited))).toBe(false)
    expect(yield* due(input(231_200, inputLimited))).toBe(true)
    const native = (tokens: number, limit: { context: number; input?: number; output: number } = inputLimited) => {
      const selected = input(tokens, limit)
      return { ...selected, model: { ...selected.model, compaction: { type: "native" as const } } }
    }
    expect(yield* due(native(231_199))).toBe(false)
    expect(yield* due(native(231_200))).toBe(true)
    expect(yield* due(native(1_000_000, { context: 0, input: undefined, output: 0 }))).toBe(false)

    // An input limit above the context window, as some catalogs and config overrides report, cannot be used in full.
    const overstated = { context: 128_000, input: 272_000, output: 128_000 }
    expect(yield* due(input(108_799, overstated))).toBe(false)
    expect(yield* due(input(108_800, overstated))).toBe(true)
    expect(yield* due(input(200_000, { context: 0, input: 272_000, output: 0 }))).toBe(false)

    // The summary's 16k output limit is more than 15% of a 100k window, so it sets the ceiling.
    const contextLimited = { context: 100_000, output: 10_000 }
    expect(yield* due(input(83_999, contextLimited))).toBe(false)
    expect(yield* due(input(84_000, contextLimited))).toBe(true)

    // The reply limit does not lower the ceiling.
    const outputLimited = { context: 100_000, output: 30_000 }
    expect(yield* due(input(83_999, outputLimited))).toBe(false)
    expect(yield* due(input(84_000, outputLimited))).toBe(true)

    // A buffer that leaves the model no room, such as one set for a larger model, falls back to the default reserve.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* compaction.transform((editor) => editor.configure({ buffer: 100_000 }))
        expect(yield* due(input(60_000, contextLimited))).toBe(false)
        expect(yield* due(input(84_000, contextLimited))).toBe(true)
      }),
    )

    // A percentage buffer is a share of the model's window.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* compaction.transform((editor) => editor.configure({ buffer: "25%" }))
        expect(yield* due(input(74_999, contextLimited))).toBe(false)
        expect(yield* due(input(75_000, contextLimited))).toBe(true)
      }),
    )

    const assistant = input(89_000, contextLimited).messages[0]
    const tool = SessionMessage.AssistantTool.make({
      type: "tool",
      id: "call_read",
      name: "read",
      state: { status: "completed", input: {}, content: [{ type: "text", text: "x".repeat(4_000) }] },
      time: { created: DateTime.makeUnsafe(0), ran: DateTime.makeUnsafe(0) },
    })
    const grown = { ...input(89_000, contextLimited), messages: [{ ...assistant, content: [tool] }] }
    // The measured request holds too little text to learn from, so what came since is put at 2.5 characters a token.
    expect(SessionCompaction.estimateContext(grown)).toBe(89_000 + 4_000 / 2.5)
    expect(yield* due(grown)).toBe(true)
    // A step estimates its prompt once and passes it; compaction decides on that instead of estimating again.
    expect(yield* due(grown, { measured: 0, estimated: 0 })).toBe(false)
    expect(yield* due(input(1_000, contextLimited), { measured: 84_000, estimated: 0 })).toBe(true)

    const interrupted = { ...assistant, id: SessionMessage.ID.create(), tokens: undefined }
    expect(SessionCompaction.estimateContext({ ...grown, messages: [...grown.messages, interrupted] })).toBe(90_602)
    // Without provider usage, include 31 tokens for the system prompt, instructions, and tool definition.
    expect(SessionCompaction.estimateContext({ ...grown, messages: [interrupted] })).toBe(33)
    // Another provider's usage is not trusted either.
    const foreign = { ...assistant, model: { ...assistant.model, providerID: Provider.ID.make("other") } }
    expect(SessionCompaction.estimateContext({ ...grown, messages: [foreign] })).toBe(33)
    expect(
      SessionCompaction.estimateContext({
        ...grown,
        messages: [{ ...interrupted, tokens: input(0, contextLimited).messages[0].tokens }],
      }),
    ).toBe(33)

    const media = [
      { type: "file", mime: "image/png", uri: `data:image/png;base64,${"a".repeat(100_000)}` },
      { type: "file", mime: "application/pdf", uri: `data:application/pdf;base64,${"a".repeat(100_000)}` },
    ] as const
    const messages = [
      { ...assistant, content: [{ ...tool, state: { status: "completed" as const, input: {}, content: media } }] },
    ]
    expect(SessionCompaction.estimateContext({ ...grown, messages })).toBe(92_500)
    const user = Schema.decodeUnknownSync(SessionMessage.User)({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "",
      files: media.map((file) => ({ mime: file.mime, data: "a".repeat(100_000), source: { type: "inline" } })),
      time: { created: 0 },
    })
    expect(SessionCompaction.estimateContext({ ...grown, messages: [...messages, user] })).toBe(96_000)
    for (const [modalities, tokens, fallback] of [
      [["text", "image"], 92_064, 1_532],
      [["text", "pdf"], 93_068, 2_034],
      [["text"], 89_132, 66],
    ] as const) {
      const selected = {
        ...grown,
        model: { ...grown.model, capabilities: { ...grown.model.capabilities, input: modalities } },
      }
      expect(SessionCompaction.estimateContext({ ...selected, messages: [...messages, user] })).toBe(tokens)
      expect(SessionCompaction.estimateContext({ ...selected, messages: [user] })).toBe(fallback + 31)
    }

    const checkpoint = Schema.decodeUnknownSync(SessionMessage.CompactionCompleted)({
      id: SessionMessage.ID.create(),
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "x".repeat(400_000),
      time: { created: 0, completed: 0 },
    })
    expect(yield* due({ ...grown, messages: [checkpoint] })).toBe(false)
  }),
)

// The overnight run of 2026-11-15 (workspace evidence overnight-2026-11-15, part 1): a step read 24,565 characters of
// code after a request of 17,613 tokens, at a compaction point of 24,000. At 4 characters a token it was put at 6,141
// and went out at 27,743; the chat's requests had run at 2.3–2.5 characters a token.
it.effect("sizes what came after the count at the characters a token held in the measured request", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_chars_per_token"))
    const system = "You are a helpful assistant."
    const read = (text: string) =>
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: "call_read",
        name: "read",
        state: { status: "completed", input: {}, content: [{ type: "text", text }] },
        time: { created: DateTime.makeUnsafe(0) },
      })
    // The request the count measured held `system` and the user's message, `chars` characters in all.
    const chat = (input: { chars: number; prompt: number; result: number; image?: boolean; compact?: number }) => ({
      session,
      model: SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000, ...(input.compact ? { compact: input.compact } : {}) },
      }),
      messages: [
        Schema.decodeUnknownSync(SessionMessage.User)({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "x".repeat(input.chars - system.length),
          ...(input.image ? { files: [{ mime: "image/png", data: "a".repeat(100), source: { type: "inline" } }] } : {}),
          time: { created: 0 },
        }),
        {
          ...Schema.decodeUnknownSync(SessionMessage.Assistant)({
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: Agent.defaultID,
            model: { id: "summary-model", providerID: "test" },
            content: [],
            tokens: { input: input.prompt, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, completed: 0 },
          }),
          content: [read("y".repeat(input.result))],
        },
      ],
      agent: { id: Agent.defaultID, info: { ...Agent.Info.default(Agent.defaultID), system } },
      initial: [],
      tools: { definitions: [], execute: () => Effect.die("unused") },
    })

    // 40,000 characters measured at 20,000 tokens: 2 a token, so 10,000 characters since are 5,000 tokens.
    expect(SessionCompaction.estimatePrompt(chat({ chars: 40_000, prompt: 20_000, result: 10_000 }))).toEqual({
      measured: 20_000,
      estimated: 5_000,
    })
    // The media the request held is taken off its count first, at what it is estimated at.
    expect(
      SessionCompaction.estimatePrompt(chat({ chars: 40_000, prompt: 21_500, result: 10_000, image: true })).estimated,
    ).toBe(5_000)
    // Never looser than 4 characters a token, nor denser than 1.
    expect(SessionCompaction.estimatePrompt(chat({ chars: 40_000, prompt: 5_000, result: 10_000 })).estimated).toBe(
      2_500,
    )
    expect(SessionCompaction.estimatePrompt(chat({ chars: 40_000, prompt: 100_000, result: 10_000 })).estimated).toBe(
      10_000,
    )
    // A request with too little text to learn from leaves it at 2.5.
    expect(SessionCompaction.estimatePrompt(chat({ chars: 9_000, prompt: 9_000, result: 10_000 })).estimated).toBe(
      4_000,
    )

    // The overnight step: 42,000 characters at 17,613 tokens, then 24,565 characters of code, at a point of 24,000.
    const step = chat({ chars: 42_000, prompt: 17_613, result: 24_565, compact: 24_000 })
    expect(SessionCompaction.estimateContext(step)).toBe(17_613 + Math.round(24_565 / (42_000 / 17_613)))
    expect((yield* compaction.compact({ reason: "auto", context: step })).status).toBe("completed")
  }),
)

/** Seeds the global project plus one session row, returning the projected session. */
const insertSession = (id: Session.ID, overrides?: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        ...overrides,
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    return yield* store
      .get(id)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die(`session missing: ${id}`))))
  })

const loaded = (session: Session.Info, messages: readonly SessionMessage.Info[]) => ({
  session,
  messages,
  model: resolved,
  agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
  initial: [{ key: Instructions.Key.make("test/session"), text: "Session instructions" }],
  tools: { definitions: [], execute: () => Effect.die("Compaction must not execute tools") },
})

/** Opens the compaction's message as the runner does when it delivers `/compact`, then compacts. */
const compactManually = (
  session: Session.Info,
  messages: readonly SessionMessage.Info[],
  inputID = SessionMessage.ID.create(),
) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const compaction = yield* SessionCompaction.Service
    yield* bus.publish(SessionEvent.Compaction.Started, {
      sessionID: session.id,
      reason: "manual",
      inputID,
    })
    return yield* compaction.compact({ reason: "manual", context: loaded(session, messages), inputID })
  })

/** Stores messages as the session's history so far, ahead of anything published next. */
const storeMessages = (sessionID: Session.ID, messages: readonly SessionMessage.Info[]) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(SessionMessageTable)
      .values(
        messages.map((message, index) => {
          const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
          return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq: index + 1, time_created: 0, data }
        }),
      )
      .run()
      .pipe(Effect.orDie)
    yield* Bus.reserveSequence(db, sessionID, messages.length)
  })

/** The recent text a manual compaction keeps when the latest exchange is one tool call with this output. */
const recentWithToolOutput = (id: Session.ID, content: SessionMessage.ToolStateCompleted["content"]) =>
  Effect.gen(function* () {
    const session = yield* insertSession(id)
    const user = (text: string) =>
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text,
        time: { created: DateTime.makeUnsafe(0) },
      })
    const assistant = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [
        {
          type: "tool",
          id: "call_read",
          name: "read",
          state: { status: "completed", input: {}, content },
          time: { created: 0 },
        },
      ],
      time: { created: 0, completed: 0 },
    })
    // A reply after the results: the model has read them, so the recent part cuts them.
    const reply = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [{ type: "text", text: "Read." }],
      time: { created: 0, completed: 0 },
    })
    const messages = [user("Earlier question"), user("Read it"), assistant, reply]
    yield* storeMessages(id, messages)
    expect(yield* compactManually(session, messages)).toEqual({
      status: "completed",
    })
    const store = yield* SessionStore.Service
    const stored = (yield* store.context(id))[0]
    return stored?.type === "compaction" && stored.status === "completed" ? stored.metadata?.recent : ""
  })

it.effect("manual compaction summarizes short context instead of no-op", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_manual_compaction")
    const parentID = Session.ID.make("ses_manual_compaction_parent")
    const userMessage = {
      id: SessionMessage.ID.create(),
      type: "user" as const,
      text: "Manual compaction should include this short conversation.",
      skills: [
        {
          id: Skill.ID.make("effect"),
          name: Skill.Name.make("Effect"),
          text: "Use Effect services and generators.",
        },
      ],
      time: { created: DateTime.makeUnsafe(0) },
    }
    const session = yield* insertSession(sessionID, { parent_id: parentID })
    const hooks = yield* PluginHooks.Service
    let hooked = 0
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        hooked = event.messages.length
        expect(JSON.stringify(event.messages)).not.toContain("Summarize only what")
      }),
    )
    const messages = [
      userMessage,
      SessionMessage.Shell.make({
        id: SessionMessage.ID.create(),
        type: "shell",
        shellID: Shell.ID.make("sh_background"),
        status: "exited",
        command: "pwd",
        metadata: { background: true },
        output: { output: "display-only-output", cursor: 19, size: 19, truncated: false },
        time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
      }),
      SessionMessage.Synthetic.make({
        id: SessionMessage.ID.create(),
        type: "synthetic",
        text: "User shell pwd completed: /project",
        time: { created: DateTime.makeUnsafe(2) },
      }),
      reply("The project is at /project."),
    ]

    const delta = yield* bus
      .subscribe(SessionEvent.Compaction.Delta)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    expect(yield* compactManually(session, messages, SessionMessage.ID.make("msg_manual_compaction"))).toEqual({
      status: "completed",
    })
    expect(Array.from(yield* Fiber.join(delta)).map((event) => event.data.text)).toEqual([
      "## Objective\n- manual summary",
    ])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(parentID)
    expect(requests[0]?.headers).toEqual({
      "x-opencode-session-id": session.id,
      "x-opencode-parent-session-id": parentID,
      "x-session-affinity": parentID,
      "X-Session-Id": parentID,
      "x-parent-session-id": parentID,
      "User-Agent": App.useragent(App.make()),
      "x-opencode-project": Project.ID.global,
      "x-opencode-session": parentID,
      "x-opencode-client": "opencode",
    })
    expect(requests[0]?.maxTokens).toBe(30_000)
    expect(JSON.stringify(requests[0]?.messages)).toContain("Manual compaction should include this short conversation.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("Use Effect services and generators.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("User shell pwd completed: /project")
    expect(requests[0]?.messages).toHaveLength(hooked + 1)
    expect(JSON.stringify(requests[0]?.messages.at(-1))).toContain("Summarize only what")
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("display-only-output")
    // The compaction message carries its own request usage so clients can show what compacting cost.
    expect(yield* store.context(sessionID)).toMatchObject([
      {
        type: "compaction",
        reason: "manual",
        summary: "## Objective\n- manual summary",
        cost: 0.0000233,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
      },
    ])
    expect(yield* store.get(sessionID)).toMatchObject({
      cost: 0.0000233,
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
    })
    expect(
      yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { type: Bus.versionedType(SessionEvent.Compaction.Started.type, 1) },
      { type: Bus.versionedType(SessionEvent.UsageRecorded.type, 1) },
      { type: Bus.versionedType(SessionEvent.Compaction.Ended.type, 1) },
    ])
  }),
)

it.effect("marks a CLIProxyPacer summary as its chat's compaction, with openforge's own summary", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_paced_compaction")
    const parentID = Session.ID.make("ses_paced_compaction_parent")
    const session = yield* insertSession(sessionID, { parent_id: parentID })
    const paced = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "summary-model", provider: "cliproxypacer", route: OpenAIChat.route }),
      { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost, limit: resolved.limit },
    )
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Summarize this paced chat.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
      reply("Paced."),
    ]
    const compaction = yield* SessionCompaction.Service
    const inputID = SessionMessage.ID.create()
    yield* (yield* Bus.Service).publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", inputID })
    expect(
      yield* compaction.compact({ reason: "manual", context: { ...loaded(session, messages), model: paced }, inputID }),
    ).toEqual({ status: "completed" })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers).toMatchObject({
      "x-opencode-session-id": sessionID,
      "X-Pacer-Session": PacerSessionID.make(sessionID),
      "X-Pacer-Parent-Session": PacerSessionID.make(parentID),
      "X-Pacer-Kind": "compaction",
    })
    expect(requests[0]?.headers).not.toHaveProperty("X-Pacer-Compact")
  }),
)

it.effect("summary updates include the retained tail in compaction hooks and the model request", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_compaction_full_update"))
    const messages = [
      SessionMessage.CompactionCompleted.make({
        id: SessionMessage.ID.create(),
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "## Objective\n- Previous objective",
        metadata: { recent: "[User]: Previous exact request" },
        time: { created: DateTime.makeUnsafe(0) },
      }),
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "The latest request supersedes the previous objective.",
        time: { created: DateTime.makeUnsafe(1) },
      }),
      reply("Understood."),
    ]
    const context = loaded(session, messages)
    const expected = SessionModelRequest.baseTranscript({ ...context, agent: context.agent.info }).messages
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        expect(event.messages).toEqual(expected)
      }),
    )

    expect(yield* compactManually(session, messages)).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    // Hooks read the checkpoint's stored metadata; the model request does not carry it.
    expect(expected[0]?.metadata).toEqual({ recent: "[User]: Previous exact request" })
    expect(requests[0].messages.slice(0, -1)).toEqual(expected.map((message) => Message.make({ ...message })))
    expect(requests[0].messages.at(-1)?.content).toEqual([{ type: "text", text: SessionCompaction.buildPrompt(true) }])
    const store = yield* SessionStore.Service
    expect(yield* store.context(session.id)).toMatchObject([
      { type: "compaction", metadata: { keepID: messages[1].id } },
    ])
  }),
)

it.effect("summary compaction past the ceiling keeps the conversation unchanged while the window fits", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_compaction_near_window"))
    // About 182k estimated tokens: past the 170k ceiling, within the 184k left after reserving room for the summary.
    const prompts = ["first", "second"].map((label) =>
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: `${label} ${"x".repeat(364_000)}`,
        time: { created: DateTime.makeUnsafe(0) },
      }),
    )
    const messages = [...prompts, reply("Read both.")]

    expect(yield* compactManually(session, messages)).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    expect(requests[0].messages).toHaveLength(4)
    expect(requests[0].messages[0].content).toEqual([{ type: "text", text: prompts[0].text }])
    expect(requests[0].maxTokens).toBeLessThan(20_000)
  }),
)

it.effect(
  "summary compaction sends the history before the tail unchanged when the whole conversation does not fit",
  () =>
    Effect.gen(function* () {
      requests = []
      const session = yield* insertSession(Session.ID.make("ses_compaction_older_fallback"))
      // About 190k estimated tokens in total, past the 184k left for the summary. The 160k before the retained
      // 30k latest exchange fits the 170k ceiling.
      const prompts = [
        ["older", 640_000],
        ["latest", 120_000],
      ].map(([label, size]) =>
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: `${label} ${"x".repeat(Number(size))}`,
          time: { created: DateTime.makeUnsafe(0) },
        }),
      )
      const messages = [...prompts, reply("Read both.")]

      expect(yield* compactManually(session, messages)).toEqual({ status: "completed" })
      expect(requests).toHaveLength(1)
      expect(requests[0].messages).toHaveLength(2)
      expect(requests[0].messages[0].content).toEqual([{ type: "text", text: prompts[0].text }])
      expect(requests[0].messages[1].content).toEqual([{ type: "text", text: SessionCompaction.buildPrompt(false) }])
    }),
)

it.effect("compaction lowers the output limit when it sends a request it could not shrink", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_unshrinkable_compaction"))
    // A previous summary estimated at 250k tokens, past the 200k window; it always stays whole.
    const messages = [
      SessionMessage.CompactionCompleted.make({
        id: SessionMessage.ID.create(),
        type: "compaction",
        status: "completed",
        reason: "manual",
        summary: "x".repeat(1_000_000),
        time: { created: DateTime.makeUnsafe(0) },
      }),
      textUser("Next question"),
      reply("Next answer"),
    ]

    expect(yield* compactManually(session, messages)).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.maxTokens).toBe(1_024)
  }),
)

it.effect("compaction keeps the output limit for a request that fits its target", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_fitting_compaction"))
    // About 160k estimated tokens, under the 170k target, leaving 40k of the 200k window.
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "x".repeat(640_000),
        time: { created: DateTime.makeUnsafe(0) },
      }),
      reply("Read it."),
    ]

    expect(yield* compactManually(session, messages)).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.maxTokens).toBe(30_000)
  }),
)

it.effect("compaction hooks can supply the summary instead of the model", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const hooks = yield* PluginHooks.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_hooked_compaction")
    const session = yield* insertSession(sessionID)
    const messages = [
      {
        id: SessionMessage.ID.create(),
        type: "user" as const,
        text: "Hooked compaction should see this conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      },
      reply("Seen."),
    ]
    let contexts = 0
    yield* hooks.register("session", "context", () => Effect.sync(() => contexts++))
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        expect(event.sessionID).toBe(sessionID)
        expect(event.agent).toBe(Agent.defaultID)
        expect(JSON.stringify(event.messages)).toContain("Hooked compaction should see this conversation.")
        event.result = { summary: "## Objective\n- hooked summary" }
      }),
    )

    expect(yield* compactManually(session, messages, SessionMessage.ID.make("msg_hooked_compaction"))).toEqual({
      status: "completed",
    })

    expect(contexts).toBe(0)
    expect(requests).toEqual([])
    expect(yield* store.context(sessionID)).toMatchObject([
      { type: "compaction", reason: "manual", summary: "## Objective\n- hooked summary" },
    ])
    expect(
      yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { type: Bus.versionedType(SessionEvent.Compaction.Started.type, 1) },
      { type: Bus.versionedType(SessionEvent.Compaction.Ended.type, 1) },
    ])
  }),
)

it.effect("native compaction fails without a model call on a route that cannot compact", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_native_unsupported"))
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Compact this natively.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    expect(
      yield* compaction.compact({
        reason: "manual",
        context: { ...loaded(session, messages), model: { ...resolved, compaction: { type: "native" } } },
        inputID: SessionMessage.ID.create(),
      }),
    ).toEqual({
      status: "failed",
      error: {
        type: "provider.unsupported-operation",
        message: "Native compaction is not supported for test/openai-chat",
      },
    })
    expect(requests).toHaveLength(0)
  }),
)

it.effect("forked session compaction reuses the fork root prompt cache key", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_fork_compaction")
    const rootID = Session.ID.make("ses_fork_compaction_root")
    const session = yield* insertSession(sessionID, {
      fork_session_id: rootID,
      fork_boundary: { type: "before", messageID: SessionMessage.ID.create() },
    })
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Summarize the forked conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
      reply("Forked."),
    ]
    expect(yield* compactManually(session, messages, SessionMessage.ID.make("msg_fork_compaction"))).toEqual({
      status: "completed",
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(rootID)
  }),
)

const measured = (text: string, input: number, created = 0) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "summary-model", providerID: "test" },
    content: [{ type: "text", text }],
    tokens: { input, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, completed: created + 1 },
  })

/**
 * A 200k window compacts at 170k. The first response measured 80k, so a background summary starts half that room,
 * 45k, before the threshold, at 125k. `near` ends past that point; `due` continues it past the threshold.
 */
const precomputeHistory = () => {
  const near = [textUser("First question"), measured("First answer", 80_000), textUser("Second question")]
  const anchor = measured("Second answer", 156_000)
  const due = [...near, anchor, textUser("Third question"), measured("Third answer", 182_000)]
  return { near: [...near, anchor], due, anchor }
}

const summaryWindow = resolved.limit.context
const summaryBuffer = summaryWindow / 8
const summaryCeiling = summaryWindow - summaryBuffer
const summaryInput = summaryCeiling * 0.9 // Past precompute's trigger, below the compaction ceiling.
const tokenText = (tokens: number) => "text".repeat(Math.ceil(tokens / Token.estimate("text")))
const oldReasoning = (input = summaryInput) => ({
  ...measured("Earlier answer", input),
  content: [{ type: "reasoning" as const, text: tokenText(summaryWindow * 3) }],
})
const summaryFixture = Effect.fnUntraced(function* (messages: readonly SessionMessage.Info[]) {
  requests = []
  const context = {
    ...loaded(yield* insertSession(Session.ID.create()), messages),
    tools: {
      definitions: [ToolDefinition.make({ name: "read", description: "Read files", inputSchema: { type: "object" } })],
      execute: () => Effect.die("Compaction must not execute tools"),
    },
  }
  const compaction = yield* SessionCompaction.Service
  yield* compaction.transform((editor) => editor.configure({ buffer: summaryBuffer }))
  return {
    context,
    compaction,
    run: (input = context) =>
      compaction.compact({ reason: "manual", context: input, inputID: SessionMessage.ID.create() }),
  }
})

for (const background of [false, true]) {
  it.effect(`summary cache prefix uses measured input with old reasoning (background=${background})`, () =>
    Effect.gen(function* () {
      const messages = [
        textUser("Earlier question"),
        // The cycle starts low, so the latest response is past the point where a background summary starts.
        oldReasoning(summaryInput / 4),
        textUser("Latest question"),
        measured("Latest answer", summaryInput),
      ]
      const fixture = yield* summaryFixture(messages)
      const builder = yield* SessionModelRequest.Service
      const normal = yield* builder.primary({
        ...fixture.context,
        agent: fixture.context.agent.id,
        ...SessionModelRequest.baseTranscript({
          ...fixture.context,
          agent: fixture.context.agent.info,
          messages: background ? messages.slice(0, -1) : messages,
        }),
      })
      if (background) yield* fixture.compaction.precompute(Effect.succeed(fixture.context))
      expect(yield* fixture.run()).toEqual({ status: "completed" })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        system: normal.request.system,
        tools: normal.request.tools,
        messages: [...normal.request.messages, Message.user(SessionCompaction.buildPrompt(false))],
        // The step's own output limit, which the conversation under the ceiling leaves room for.
        maxTokens: normal.request.maxTokens,
      })
    }),
  )
}

it.effect("summary cache prefix still flattens genuinely oversized measured input", () =>
  Effect.gen(function* () {
    const fixture = yield* summaryFixture([
      textUser(tokenText(summaryCeiling)),
      measured("Latest answer", summaryWindow + summaryBuffer),
    ])
    expect(yield* fixture.run()).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    expect(requests[0].tools).toEqual([])
    expect(requests[0].messages).toHaveLength(2)
    expect(JSON.stringify(requests[0].messages[0])).toContain("characters omitted")
  }),
)

it.effect("summary measured recovery shrinks from the rejected measured size", () =>
  Effect.gen(function* () {
    const text = tokenText(summaryCeiling / 2)
    const fixture = yield* summaryFixture([
      textUser(text),
      oldReasoning(summaryCeiling / 2),
      textUser(text),
      measured("Latest answer", summaryCeiling),
    ])
    // Reject until the original exchange is actually shortened, without duplicating a token estimator in the mock.
    reject = (request) =>
      request.messages.some((message) =>
        message.content.some((part) => part.type === "text" && part.text.includes(text)),
      )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        reject = undefined
      }),
    )
    expect(yield* fixture.run()).toEqual({ status: "completed" })
    // The retained exchange fits the 85% and 70% targets; 50% of the measured input forces truncation.
    expect(requests).toHaveLength(4)
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("characters omitted")
  }),
)

it.effect("summary cache prefix survives hooks that shape every request alike", () =>
  Effect.gen(function* () {
    const fixture = yield* summaryFixture([
      textUser("Earlier question"),
      oldReasoning(),
      textUser("Latest question"),
      measured("Latest answer", summaryInput),
    ])
    // Built-in tool plugins register one hook for both normal and compaction requests.
    const hooks = yield* PluginHooks.Service
    const describe = (event: { tools: Record<string, { description: string }> }) =>
      Effect.sync(() => {
        if (event.tools.read) event.tools.read.description = "Read files from the project"
      })
    yield* hooks.register("session", "context", describe)
    yield* hooks.register("session", "compaction", describe)
    expect(yield* fixture.run()).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    expect(requests[0].tools.map((tool) => tool.description)).toEqual(["Read files from the project"])
  }),
)

it.effect("summary resends as text when a hook makes the request larger than the measured count", () =>
  Effect.gen(function* () {
    const fixture = yield* summaryFixture([
      textUser("Earlier question"),
      oldReasoning(),
      textUser("Latest question"),
      measured("Latest answer", summaryInput),
    ])
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.system.push({ type: "text", text: "Plugin guidance" })
      }),
    )
    // The provider rejects the unchanged request, which the measured count said would fit.
    reject = (request) => request.tools.length > 0
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        reject = undefined
      }),
    )
    expect(yield* fixture.run()).toEqual({ status: "completed" })
    expect(requests).toHaveLength(2)
    expect(requests[0].tools).toEqual(fixture.context.tools.definitions)
    expect(requests[1].tools).toEqual([])
  }),
)

it.effect("summary measured recovery reuses usage only for the matching agent", () =>
  Effect.gen(function* () {
    const fixture = yield* summaryFixture([textUser("Earlier question"), oldReasoning()])
    const agent = Agent.ID.make("other")
    const context = {
      ...fixture.context,
      agent: {
        id: agent,
        info: { ...Agent.Info.default(agent), system: tokenText(summaryWindow - summaryBuffer / 5) },
      },
    }
    expect(yield* fixture.run(context)).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    expect(requests[0].maxTokens).toBeLessThanOrEqual(summaryBuffer / 5)
    // Switching back restores the measured prefix; discarding usage for every agent is not sufficient.
    expect(yield* fixture.run()).toEqual({ status: "completed" })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      tools: fixture.context.tools.definitions,
      messages: [
        ...toLLMMessages(fixture.context.messages, resolved.ref),
        Message.user(SessionCompaction.buildPrompt(false)),
      ],
      // The conversation under the ceiling leaves the model's whole output limit, as its step has.
      maxTokens: resolved.limit.output,
    })
  }),
)

it.effect("background summaries stay off when disabled", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    yield* compaction.transform((editor) => editor.configure({ background: false }))
    const session = yield* insertSession(Session.ID.make("ses_precompute_off"))
    const history = precomputeHistory()

    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, history.due) })).toEqual({
      status: "completed",
    })
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).toContain("Third answer")
  }),
)

it.effect("automatic compaction swaps in the background summary without another model call", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const sessionID = Session.ID.make("ses_precompute_swap")
    const session = yield* insertSession(sessionID)
    const history = precomputeHistory()
    yield* storeMessages(sessionID, history.due)

    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, history.due) })).toEqual({
      status: "completed",
    })

    // The one request summarized the prefix the latest response was generated from.
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).toContain("Second question")
    expect(JSON.stringify(requests[0].messages)).not.toContain("Second answer")
    expect(yield* store.context(sessionID)).toMatchObject([
      {
        type: "compaction",
        reason: "auto",
        summary: "## Objective\n- manual summary",
        metadata: {
          keepID: history.anchor.id,
          recent: "[Assistant]: Second answer\n\n[User]: Third question\n\n[Assistant]: Third answer",
        },
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
      },
    ])
    // The background call is billed once, when it finishes, and the compaction ends after it.
    const types = (yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)).map((row) => row.type)
    expect(types.at(-1)).toBe(Bus.versionedType(SessionEvent.Compaction.Ended.type, 1))
    expect(types.toSorted()).toEqual(
      [
        Bus.versionedType(SessionEvent.UsageRecorded.type, 1),
        Bus.versionedType(SessionEvent.Compaction.Started.type, 1),
        Bus.versionedType(SessionEvent.Compaction.Ended.type, 1),
      ].toSorted(),
    )
  }),
)

it.effect("a background summary swapped in sends the prompt no request carried after it as itself", () =>
  Effect.gen(function* () {
    requests = []
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const sessionID = Session.ID.make("ses_precompute_unsent")
    const session = yield* insertSession(sessionID)
    const history = precomputeHistory()
    const prompt = textUser("Fourth question")
    yield* storeMessages(sessionID, [...history.due, prompt])

    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, [...history.due, prompt]) })).toEqual({
      status: "completed",
    })

    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).not.toContain("Fourth question")
    expect(yield* store.context(sessionID)).toMatchObject([
      {
        type: "compaction",
        metadata: {
          keepID: history.anchor.id,
          [SessionRecentText.UNSENT]: prompt.id,
          recent: "[Assistant]: Second answer\n\n[User]: Third question\n\n[Assistant]: Third answer",
        },
      },
      { type: "user", id: prompt.id, text: "Fourth question" },
    ])
  }),
)

it.effect("automatic compaction waits for a background summary still being written", () =>
  Effect.gen(function* () {
    requests = []
    const release = yield* Deferred.make<void>()
    beforeResponse = Deferred.await(release)
    const bus = yield* Bus.Service
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_join"))
    const history = precomputeHistory()
    const started = yield* bus
      .subscribe(SessionEvent.Compaction.Started)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }))

    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    const compacting = yield* compaction
      .compact({ reason: "auto", context: loaded(session, history.due) })
      .pipe(Effect.forkChild({ startImmediately: true }))

    // The compaction shows as running while the summary it waits for is still being written.
    expect(yield* Fiber.join(started)).toHaveLength(1)
    expect(compacting.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)

    expect(yield* Fiber.join(compacting)).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
  }).pipe(Effect.ensuring(Effect.sync(() => (beforeResponse = Effect.void)))),
)

it.effect("a model switch waits for the new model's first response before summarizing in the background", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_switch"))
    const history = precomputeHistory()
    const switched = (messages: readonly SessionMessage.Info[]) => ({
      ...loaded(session, messages),
      model: { ...resolved, ref: { ...resolved.ref, id: Model.ID.make("other") } },
    })

    // The latest response came from the previous model, so the new one has no cached prefix to summarize from.
    yield* compaction.precompute(Effect.succeed(switched(history.near)))
    expect(yield* compaction.compact({ reason: "auto", context: switched(history.due) })).toEqual({
      status: "completed",
    })
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).toContain("Third answer")
  }),
)

it.effect("a background summary that fell too far behind is replaced from a newer response", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_behind"))
    const history = precomputeHistory()
    // About 75k tokens arrived after the summarized prefix, past the 68k (40% of the 170k budget) that may stay
    // verbatim beside it.
    const behind = [...history.near, textUser("x".repeat(300_000)), measured("Burst handled", 160_000)]

    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    yield* compaction.precompute(Effect.succeed(loaded(session, behind)))
    const due = [...behind, textUser("Next question"), measured("Next answer", 182_000)]
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, due) })).toEqual({
      status: "completed",
    })

    // Compaction swapped in the newer summary, which ends before the latest response, instead of writing one.
    const summarized = JSON.stringify(requests.at(-1)?.messages)
    expect(summarized).toContain("x".repeat(1_000))
    expect(summarized).not.toContain("Burst handled")
  }),
)

it.effect("a failed background summary is retried from a newer response, then left until compaction", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_failed"))
    const history = precomputeHistory()
    const later = [...history.near, textUser("Third question"), measured("Third answer", 160_000)]
    const latest = [...later, textUser("Fourth question"), measured("Fourth answer", 165_000)]
    const precomputeFailing = (messages: readonly SessionMessage.Info[]) =>
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>()
        beforeResponse = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.die("provider down")))
        yield* compaction.precompute(Effect.succeed(loaded(session, messages)))
        yield* Deferred.await(reached)
        yield* Effect.yieldNow
      })

    yield* precomputeFailing(history.near)
    expect(requests).toHaveLength(1)
    // The same response would send the same request again.
    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    expect(requests).toHaveLength(1)

    yield* precomputeFailing(later)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1].messages)).toContain("Second answer")

    // Two failures in a row stop background summaries until the next compaction.
    yield* compaction.precompute(Effect.succeed(loaded(session, latest)))
    expect(requests).toHaveLength(2)
  }).pipe(Effect.ensuring(Effect.sync(() => (beforeResponse = Effect.void)))),
)

it.effect("compaction summarizes as usual when the background summary no longer fits the conversation", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_stale"))
    const history = precomputeHistory()
    // About 75k tokens arrived after the summarized prefix, past the 68k that may stay verbatim beside it.
    const burst = [...history.near, textUser("x".repeat(300_000)), measured("Burst handled", 182_000)]

    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, burst) })).toEqual({
      status: "completed",
    })
    // The background summary is stopped; the summary that is kept covers the whole conversation.
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Burst handled")
  }),
)

// The summary is plain text, so it still serves after a model switch, and after the compaction agent's own model
// stands in for the session's.
it.effect("a background summary is swapped in for a different model", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_other_model"))
    const history = precomputeHistory()

    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    const switched = {
      ...loaded(session, history.due),
      model: { ...resolved, ref: { ...resolved.ref, id: Model.ID.make("other") } },
    }
    expect(yield* compaction.compact({ reason: "auto", context: switched })).toEqual({ status: "completed" })

    // The one request ended before the response the summary started from.
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).not.toContain("Second answer")
  }),
)

it.effect("an overflow compaction swaps in the background summary", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_overflow"))
    const history = precomputeHistory()

    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    expect(yield* compaction.compact({ reason: "overflow", context: loaded(session, history.due) })).toEqual({
      status: "completed",
    })

    // The one request ended before the response the summary started from.
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).not.toContain("Second answer")
  }),
)

it.effect("a background summary starts when the latest response already passed the threshold", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_past"))
    const history = precomputeHistory()

    // The turn ended past the threshold; the summary is written while the session is idle.
    yield* compaction.precompute(Effect.succeed(loaded(session, history.due)))
    const next = [...history.due, textUser("Fourth question")]
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, next) })).toEqual({
      status: "completed",
    })

    expect(requests).toHaveLength(1)
    const summarized = JSON.stringify(requests[0].messages)
    expect(summarized).toContain("Third question")
    expect(summarized).not.toContain("Third answer")
  }),
)

// openforge: a summary continues its step's prompt, so it sends that step's manual thinking budget, which a changed one
// would miss the cache of (`SessionThinkingBudget`).
it.effect("a background summary sends the manual thinking budget of the step whose prompt it continues", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const builder = yield* SessionModelRequest.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_budget"))
    const claude = SessionRunnerModel.resolved(
      LanguageModel.make({
        id: "claude-sonnet-4-5",
        provider: "test",
        route: AnthropicMessages.route,
        options: { providerOptions: { thinking: { type: "enabled", budgetTokens: 16_000 } } },
      }),
      { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost, limit: resolved.limit },
    )
    const answer = (text: string, input: number) => ({ ...measured(text, input), model: claude.ref })
    // The latest answer measured past where a background summary starts, 1,500 before the 170k threshold.
    const near = [
      textUser("First question"),
      answer("First answer", 167_000),
      textUser("Second question"),
      answer("Second answer", 169_000),
    ]
    const context = { ...loaded(session, near), model: claude }
    // The step that wrote the latest answer, with what the runner gives it.
    const before = { ...context, messages: near.slice(0, -1) }
    const step = yield* builder.primary({
      ...before,
      agent: before.agent.id,
      ...SessionModelRequest.baseTranscript({ ...before, agent: before.agent.info }),
      inputTokens: SessionCompaction.estimatePrompt(before),
      peak: SessionThinkingBudget.peak(before.messages, claude.ref),
      threshold: compaction.threshold(claude.limit),
    })

    yield* compaction.precompute(Effect.succeed(context))
    yield* compaction.compact({
      reason: "auto",
      context: { ...context, messages: [...near, textUser("Third question"), answer("Third answer", 182_000)] },
    })

    const budget = (request: LLMRequest) =>
      compileRequest(request).pipe(
        Effect.map((compiled) => (compiled.body as { thinking?: { budget_tokens?: number } }).thinking?.budget_tokens),
      )
    // The most that fits at the 170k compaction point: half of 198,000 - 170,000 less the 4,096 margin.
    expect(compaction.threshold(claude.limit)).toBe(170_000)
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("Second answer")
    expect(yield* budget(step.request)).toBe(11_952)
    expect(yield* budget(requests[0]!)).toBe(11_952)
  }),
)

it.effect("a background summary keeps a tail longer than twice keep while it stays under 40% of the budget", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_long_tail"))
    const history = precomputeHistory()
    // About 35k tokens arrived after the summarized prefix: more than twice keep, less than 68k.
    const burst = [...history.near, textUser("x".repeat(140_000)), measured("Burst handled", 160_000)]
    const due = [...burst, textUser("Next question"), measured("Next answer", 182_000)]

    yield* compaction.precompute(Effect.succeed(loaded(session, history.near)))
    yield* compaction.precompute(Effect.succeed(loaded(session, burst)))
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, due) })).toEqual({
      status: "completed",
    })

    // The first summary was kept and swapped in: one request, ending before the response it was started from.
    expect(requests).toHaveLength(1)
    const summarized = JSON.stringify(requests[0].messages)
    expect(summarized).toContain("Second question")
    expect(summarized).not.toContain("Second answer")
  }),
)

it.effect("a background summary starts a fixed lead before the threshold, not at a share of it", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_lead"))
    // A 1M window compacts at 850k, so a background summary starts 60k before that, at 790k.
    const large = (messages: readonly SessionMessage.Info[]) => ({
      ...loaded(session, messages),
      model: { ...resolved, limit: { context: 1_000_000, output: 128_000 } },
    })
    const early = [textUser("First question"), measured("First answer", 100_000), textUser("Second question")]
    const before = [...early, measured("Second answer", 760_000)]
    const within = [...before, textUser("Third question"), measured("Third answer", 800_000)]
    const due = [...within, textUser("Fourth question"), measured("Fourth answer", 860_000)]

    // 760k is past 85% of the threshold, but still more than the lead away from it.
    yield* compaction.precompute(Effect.succeed(large(before)))
    yield* compaction.precompute(Effect.succeed(large(within)))
    expect(yield* compaction.compact({ reason: "auto", context: large(due) })).toEqual({ status: "completed" })

    expect(requests).toHaveLength(1)
    const summarized = JSON.stringify(requests[0].messages)
    expect(summarized).toContain("Third question")
    expect(summarized).not.toContain("Third answer")
  }),
)

it.effect("a background summary starts on a window whose threshold is under 64k", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_precompute_small"))
    // A 64k window compacts at 48k. The first response measured 20k, so half that room, 14k, sets the start at 34k.
    const small = (messages: readonly SessionMessage.Info[]) => ({
      ...loaded(session, messages),
      model: { ...resolved, limit: { context: 64_000, output: 16_000 } },
    })
    const early = [textUser("First question"), measured("First answer", 20_000), textUser("Second question")]
    const before = [...early, measured("Second answer", 30_000)]
    const within = [...before, textUser("Third question"), measured("Third answer", 40_000)]
    const due = [...within, textUser("Fourth question"), measured("Fourth answer", 50_000)]

    yield* compaction.precompute(Effect.succeed(small(before)))
    yield* compaction.precompute(Effect.succeed(small(within)))
    expect(yield* compaction.compact({ reason: "auto", context: small(due) })).toEqual({ status: "completed" })

    expect(requests).toHaveLength(1)
    const summarized = JSON.stringify(requests[0].messages)
    expect(summarized).toContain("Third question")
    expect(summarized).not.toContain("Third answer")
  }),
)

it.effect("a background summary waits for a response whose prompt is still cached", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const history = precomputeHistory()
    const later = (created: number) => [
      ...history.near,
      textUser("Third question"),
      measured("Third answer", 160_000, created),
    ]
    const summarizedAfterBreak = (sessionID: string, ttl?: "1h") =>
      Effect.gen(function* () {
        requests = []
        const session = yield* insertSession(Session.ID.make(sessionID))
        const context = (messages: readonly SessionMessage.Info[]) => ({
          ...loaded(session, messages),
          model: { ...resolved, ...(ttl ? { cache: { ttl } } : {}) },
        })
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        // The latest response was written ten minutes ago; then a new one arrives.
        yield* compaction.precompute(Effect.succeed(context(history.near)))
        const resumed = later(now)
        yield* compaction.precompute(Effect.succeed(context(resumed)))
        const due = [...resumed, textUser("Fourth question"), measured("Fourth answer", 182_000, now)]
        expect(yield* compaction.compact({ reason: "auto", context: context(due) })).toEqual({ status: "completed" })
        expect(requests).toHaveLength(1)
        return JSON.stringify(requests[0].messages)
      })

    yield* TestClock.adjust("10 minutes")
    // Past the default five-minute cache, the summary starts from the next response instead.
    expect(yield* summarizedAfterBreak("ses_precompute_cold")).toContain("Third question")
    // A model that keeps its cache for an hour summarizes the older response right away.
    expect(yield* summarizedAfterBreak("ses_precompute_hour", "1h")).not.toContain("Third question")
  }),
)

// Workspace spec `docs/specs/compaction-threshold-per-client.md`, section 3: a model's compaction point.
const pointed = (limit: Partial<SessionRunnerModel.Resolved["limit"]>) => ({
  ...resolved,
  limit: { ...resolved.limit, ...limit },
})

it.effect("a compaction point is a ceiling as it is; the lower of it and the window less the reserve wins", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_compaction_point"))
    // Whether an automatic compaction of a prompt of `tokens` on a model of `limit` is due rather than skipped.
    const due = (limit: Partial<SessionRunnerModel.Resolved["limit"]>, tokens: number) =>
      compaction
        .compact({
          reason: "auto",
          context: { ...loaded(session, []), model: pointed(limit) },
          estimate: { measured: tokens, estimated: 0 },
        })
        .pipe(Effect.map((outcome) => outcome.status !== "skipped"))

    // On a 200k window, a point of 100k compacts at 100k, not at 100k less a reserve.
    expect(yield* due({ compact: 100_000 }, 99_999)).toBe(false)
    expect(yield* due({ compact: 100_000 }, 100_000)).toBe(true)
    // A point above the window less the reserve, 170k, leaves that ceiling.
    expect(yield* due({ compact: 190_000 }, 169_999)).toBe(false)
    expect(yield* due({ compact: 190_000 }, 170_000)).toBe(true)
    // The window is the smaller of the context and input limits: 85% of 272k is 231.2k.
    const inputLimited = { context: 400_000, input: 272_000, output: 128_000 }
    expect(yield* due({ ...inputLimited, compact: 250_000 }, 231_199)).toBe(false)
    expect(yield* due({ ...inputLimited, compact: 250_000 }, 231_200)).toBe(true)
    expect(yield* due({ ...inputLimited, compact: 200_000 }, 199_999)).toBe(false)
    expect(yield* due({ ...inputLimited, compact: 200_000 }, 200_000)).toBe(true)
    // With no window known, the point alone limits the prompt.
    expect(yield* due({ context: 0, output: 0, compact: 50_000 }, 49_999)).toBe(false)
    expect(yield* due({ context: 0, output: 0, compact: 50_000 }, 50_000)).toBe(true)
    expect(yield* due({ context: 0, output: 0 }, 1_000_000)).toBe(false)
    // A model without a point compacts as before.
    expect(yield* due({}, 169_999)).toBe(false)
    expect(yield* due({}, 170_000)).toBe(true)

    // The `compaction.buffer` reserve applies to the window only.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* compaction.transform((editor) => editor.configure({ buffer: 50_000 }))
        expect(yield* due({ compact: 160_000 }, 149_999)).toBe(false)
        expect(yield* due({ compact: 160_000 }, 150_000)).toBe(true)
        expect(yield* due({ compact: 120_000 }, 119_999)).toBe(false)
        expect(yield* due({ compact: 120_000 }, 120_000)).toBe(true)
      }),
    )
  }),
)

it.effect("a chat compacted at its point still goes out whole while the model's own window fits the summary", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_compaction_point_room"))
    // About 150k estimated tokens: past the 100k point, within the 184k the 200k window leaves for the summary.
    const prompts = ["first", "second"].map((label) => textUser(`${label} ${"x".repeat(300_000)}`))
    const messages = [...prompts, reply("Read.")]

    expect(
      yield* SessionCompaction.Service.use((compaction) =>
        compaction.compact({
          reason: "auto",
          context: { ...loaded(session, messages), model: pointed({ compact: 100_000 }) },
        }),
      ),
    ).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    expect(requests[0].messages).toHaveLength(4)
    expect(requests[0].messages[0].content).toEqual([{ type: "text", text: prompts[0].text }])
  }),
)

it.effect("a background summary starts as the context nears the model's point, and compaction swaps it in there", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    // A background summary starts within upstream's lead of the 100k point: half the 60k the cycle started below it
    // (its first measured prompt is 40k), so at 70k. The 200k window alone would compact at 170k.
    const history = (early: number) => {
      const near = [textUser("First question"), measured("First answer", 40_000), textUser("Second question")]
      const anchor = measured("Second answer", early)
      return {
        near: [...near, anchor],
        due: [...near, anchor, textUser("Third question"), measured("Third answer", 100_000)],
      }
    }
    const compactAt = (id: string, early: number) =>
      Effect.gen(function* () {
        requests = []
        const sessionID = Session.ID.make(id)
        const session = yield* insertSession(sessionID)
        const messages = history(early)
        yield* storeMessages(sessionID, messages.due)
        const at = (list: readonly SessionMessage.Info[]) => ({
          ...loaded(session, list),
          model: pointed({ compact: 100_000 }),
        })
        yield* compaction.precompute(Effect.succeed(at(messages.near)))
        expect(yield* compaction.compact({ reason: "auto", context: at(messages.due) })).toEqual({
          status: "completed",
        })
        expect(requests).toHaveLength(1)
        return JSON.stringify(requests[0].messages)
      })

    // Below it no background summary starts, so compaction summarizes the whole conversation.
    expect(yield* compactAt("ses_precompute_point_early", 65_000)).toContain("Third answer")
    // Past it, one does, from the prefix the latest response was written from, and compaction takes it.
    const swapped = yield* compactAt("ses_precompute_point_near", 90_000)
    expect(swapped).toContain("Second question")
    expect(swapped).not.toContain("Second answer")
  }),
)
