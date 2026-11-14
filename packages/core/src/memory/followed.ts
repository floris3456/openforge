export * as MemoryFollowed from "./followed.js"

import { and, desc, eq, gt, gte, isNotNull, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import { SessionEvent } from "../session/event.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable, SessionPartTable } from "../session/sql.js"
import { SessionStore } from "../session/store.js"
import { MemoryClient } from "./client.js"
import { MemoryPromptTable } from "./prompt.sql.js"
import { MemorySecrets } from "./secrets.js"

// What followed a search (the workspace's spec `docs/specs/memory.md`, section 9): openforge adds to a search's row of
// the recall log the step that followed it and the person's next message. The ledger is the chat itself: a start
// block's message, a prompt's message of close entries and a `recall` call's result keep their search in their metadata
// (`project`, `recall`, `entries`), a prompt that got none in its `memory_prompt` row (`MemoryPrompt`), and
// which step followed which search, or which message of the person, is read from the order of the chat's messages. It
// runs only while capabilities say `recalls`, beside the chat and never in its way: each row gets one try in the
// background, dropped on failure; a restart may lose some.

/** How long one call may take. */
const TIMEOUT = "2 seconds"
/** How long a step's text and the person's message may be, in code points. */
const STEP = 4_000
const PERSON = 2_000
/** How many searches since the person's message before get their next one. */
const SEARCHES = 10

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryFollowed") {}

/** A search as the chat keeps it. */
const Searched = Schema.Struct({
  project: Schema.String,
  recall: Schema.String,
  entries: Schema.Array(Schema.String),
})
type Searched = typeof Searched.Type
const searchedOf = Schema.decodeUnknownOption(Searched)
/** A `recall` call as its part is stored: its search, once it completed. */
const recallOf = Schema.decodeUnknownOption(
  Schema.Struct({ state: Schema.Struct({ status: Schema.Literal("completed"), metadata: Searched }) }),
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const catalogs = yield* PacerModels.Service
    const client = yield* MemoryClient.Service
    const projects = yield* PacerProject.Service
    const scope = yield* Effect.scope

    const recalls = catalogs.get().pipe(Effect.map((catalog) => catalog?.pacer?.memory?.recalls === true))

    /** The chat's parent, for a subagent's calls; none for a lead or a chat no longer there. */
    const parentOf = (sessionID: SessionSchema.ID) =>
      store.get(sessionID).pipe(Effect.map((session) => session?.parentID))

    const send = (
      searched: Searched,
      input: Omit<MemoryClient.AfterInput, "by">,
      by: MemoryClient.By & { readonly chat: SessionSchema.ID },
      parentID: SessionSchema.ID | undefined,
    ) =>
      client
        .withHeaders(PacerHeaders.chat({ sessionID: by.chat, parentID, project: projects.headers(searched.project) }))
        .after(searched.project, searched.recall, { ...input, by }, { timeout: TIMEOUT })
        .pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logDebug("what followed a search was not added", { recall: searched.recall, reason: error.message }),
          ),
        )

    /** After a step: its text and calls go to the searches it was the first to see. */
    const stepped = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
      if (!(yield* recalls)) return
      const message = (yield* store.message(messageID))?.message
      const seq = yield* seqOf(messageID)
      if (message?.type !== "assistant" || seq === undefined) return
      const before = yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "assistant"),
            lt(SessionMessageTable.seq, seq),
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      // A recall's result is read by the step after its own; a start block by the first step after it.
      const searches = [
        ...(before ? (yield* recallParts(sessionID, { only: before.id })).map((part) => part.searched) : []),
        ...(yield* blocks(sessionID, before?.seq ?? -1, seq)).map((block) => block.searched),
      ]
      if (!searches.length) return
      const step = cut(
        MemorySecrets.redact(
          [
            ...message.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])),
            ...message.content.flatMap((part) =>
              part.type === "tool"
                ? [
                    `${part.name} ${typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)}`,
                  ]
                : [],
            ),
          ].join("\n"),
        ),
        STEP,
      )
      if (!step) return
      const parentID = yield* parentOf(sessionID)
      const acts = message.content.flatMap((part): NonNullable<MemoryClient.AfterInput["acted"]> => {
        if (part.type !== "tool" || part.state.status !== "completed") return []
        const input = part.state.input
        if (part.name === "remember" && typeof input.supersedes === "string")
          return [{ id: input.supersedes, how: "superseded" }]
        if (part.name === "forget" && typeof input.id === "string") return [{ id: input.id, how: "forgotten" }]
        return []
      })
      yield* Effect.forEach(
        searches,
        (searched) => {
          const acted = acts.filter(
            (act, index) =>
              searched.entries.includes(act.id) && acts.findIndex((other) => other.id === act.id) === index,
          )
          return send(searched, { step, acted }, { role: message.agent, chat: sessionID }, parentID)
        },
        { concurrency: "unbounded", discard: true },
      )
    })

    /** When the person writes: their message goes to each search since their message before, the newest 10. */
    const answered = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
      if (!(yield* recalls)) return
      const row = yield* db
        .select({
          seq: SessionMessageTable.seq,
          type: SessionMessageTable.type,
          text: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.text')`,
        })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      // Only a message the person typed: an inbox's synthetic message or control is not theirs.
      if (row?.type !== "user" || typeof row.text !== "string") return
      const person = cut(MemorySecrets.redact(row.text), PERSON)
      if (!person.trim()) return
      const newest = (type: "user" | "assistant") =>
        db
          .select({
            seq: SessionMessageTable.seq,
            agent: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.agent')`,
          })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, type),
              lt(SessionMessageTable.seq, row.seq),
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
      const from = (yield* newest("user"))?.seq ?? -1
      const searches = [
        ...(yield* blocks(sessionID, from, row.seq)),
        ...(yield* recallParts(sessionID, { from, to: row.seq })),
      ]
        .toSorted((a, b) => b.seq - a.seq || b.ordinal - a.ordinal)
        .slice(0, SEARCHES)
      // Who answers is the chat's agent as it last ran; a chat that has not run since has nobody to add it for.
      const agent = (yield* newest("assistant"))?.agent
      if (!searches.length || typeof agent !== "string") return
      const parentID = yield* parentOf(sessionID)
      yield* Effect.forEach(
        searches,
        (search) => send(search.searched, { person }, { role: agent, chat: sessionID }, parentID),
        { concurrency: "unbounded", discard: true },
      )
    })

    const seqOf = (messageID: SessionMessage.ID) =>
      db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.seq),
        )

    /**
     * The searches of the start blocks and the prompts' messages after `from` and before `to`, and of the prompts there
     * (from `from` on) that got no message (`MemoryPrompt`).
     */
    const blocks = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, from: number, to: number) {
      const messages = yield* db
        .select({
          seq: SessionMessageTable.seq,
          memory: sql<unknown>`coalesce(json_extract(${SessionMessageTable.data}, '$.metadata.memory'), json_extract(${SessionMessageTable.data}, '$.metadata.memoryPrompt'))`,
        })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "synthetic"),
            gt(SessionMessageTable.seq, from),
            lt(SessionMessageTable.seq, to),
            sql`coalesce(json_extract(${SessionMessageTable.data}, '$.metadata.memory.recall'), json_extract(${SessionMessageTable.data}, '$.metadata.memoryPrompt.recall')) is not null`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const asked = yield* db
        .select({ seq: SessionMessageTable.seq, project: MemoryPromptTable.project, recall: MemoryPromptTable.recall })
        .from(MemoryPromptTable)
        .innerJoin(SessionMessageTable, eq(SessionMessageTable.id, MemoryPromptTable.message_id))
        .where(
          and(
            eq(MemoryPromptTable.session_id, sessionID),
            gte(SessionMessageTable.seq, from),
            lt(SessionMessageTable.seq, to),
            isNotNull(MemoryPromptTable.recall),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return [
        ...messages.flatMap((row) =>
          Option.match(searchedOf(typeof row.memory === "string" ? JSON.parse(row.memory) : row.memory), {
            onNone: () => [],
            onSome: (searched) => [{ seq: row.seq, ordinal: -1, searched }],
          }),
        ),
        ...asked.flatMap((row) =>
          row.recall === null
            ? []
            : [{ seq: row.seq, ordinal: -1, searched: { project: row.project, recall: row.recall, entries: [] } }],
        ),
      ]
    })

    /** The completed `recall` calls of one step, or of the steps after `from` and before `to`. */
    const recallParts = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      where: { readonly only: SessionMessage.ID } | { readonly from: number; readonly to: number },
    ) {
      // A step's calls are in its row or, once written as parts, in the part table: the steps that called recall.
      const rows = yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "assistant"),
            ...("only" in where
              ? [eq(SessionMessageTable.id, where.only)]
              : [gt(SessionMessageTable.seq, where.from), lt(SessionMessageTable.seq, where.to)]),
            sql`(exists (select 1 from json_each(${SessionMessageTable.data}, '$.content') as part
                  where json_extract(part.value, '$.name') = 'recall')
              or exists (select 1 from ${SessionPartTable} where ${SessionPartTable.message_id} = ${SessionMessageTable.id}
                  and json_extract(${SessionPartTable.data}, '$.name') = 'recall'))`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const steps = yield* Effect.forEach(rows, (row) =>
        store.message(row.id).pipe(Effect.map((found) => ({ seq: row.seq, message: found?.message }))),
      )
      return steps.flatMap((step) =>
        step.message?.type === "assistant"
          ? step.message.content.flatMap((part, ordinal) =>
              part.type === "tool" && part.name === "recall"
                ? Option.match(recallOf(part), {
                    onNone: () => [],
                    onSome: (call) => [{ seq: step.seq, ordinal, searched: call.state.metadata }],
                  })
                : [],
            )
          : [],
      )
    })

    // Each event is handled on its own fiber, so a slow database read or server never holds up the next.
    const handle = <E, R>(effect: Effect.Effect<void, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logDebug("what followed a search could not be read", { cause })),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )
    yield* bus.subscribe([SessionEvent.Step.Ended, SessionEvent.InboxDelivered]).pipe(
      Stream.runForEach((event) =>
        event.type === "session.step.ended"
          ? handle(stepped(event.data.sessionID, event.data.assistantMessageID))
          : handle(answered(event.data.sessionID, event.data.inboxID)),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({})
  }),
)

function cut(text: string, most: number) {
  return [...text].slice(0, most).join("")
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, SessionStore.node, PacerModels.node, PacerProject.node, MemoryClient.node],
})
