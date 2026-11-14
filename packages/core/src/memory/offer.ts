export * as MemoryOffer from "./offer.js"

import { and, desc, eq, gt, gte, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable } from "../session/sql.js"

// What memory a chat is offered: what its start block in view says, which goes in at its first step and at the first
// step after each compaction (`MemoryStart`); the block's metadata records it (the workspace's spec
// `docs/specs/memory.md`, sections 3 and 4). It is read where a chat's start is recorded, at its cold points; between
// them the chat keeps the tools recorded with its start (`SessionPromptStart`), whatever the server says meanwhile.

type Db = Database.Interface["db"]

/** The memory tools, which a chat has only while its start block is in view. */
export const tools = new Set(["remember", "recall", "forget", "task"])

export interface Offered {
  /** `remember`, `recall` and `forget`. */
  readonly memory: boolean
  /** The `task` tool. */
  readonly tasks: boolean
}

const none: Offered = { memory: false, tasks: false }

/**
 * What the chat's start block in view offers it. One lookup on the session's type index for a chat without a block,
 * two with one, decoding no message.
 */
export const offered = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID) {
  const block = yield* newestBlock(db, sessionID)
  return block?.visible ? ({ memory: true, tasks: block.tasks } satisfies Offered) : none
})

/**
 * The chat's newest start block, and whether it is in the model's view: after the latest completed compaction, which
 * `SessionHistory.load` starts from.
 */
export const newestBlock = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID) {
  const block = yield* db
    .select({
      seq: SessionMessageTable.seq,
      text: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.text')`,
      tasks: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.memory.tasks')`,
      unavailable: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.memory.unavailable')`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "synthetic"),
        sql`json_extract(${SessionMessageTable.data}, '$.metadata.memory') is not null`,
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!block) return undefined
  const compaction = yield* latestCompaction(db, sessionID)
  return {
    visible: compaction === undefined || block.seq > compaction,
    text: typeof block.text === "string" ? block.text : undefined,
    // SQLite's JSON true; a block written before tasks were recorded offers none.
    tasks: block.tasks === 1 || block.tasks === true,
    /** Built while memory could not be reached. */
    unavailable: block.unavailable === 1 || block.unavailable === true,
  }
})

/** Whether the chat had a step since its latest completed compaction, or since it began: its cache is not new. */
export const stepped = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID) {
  const compaction = yield* latestCompaction(db, sessionID)
  const row = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        compaction === undefined ? undefined : gt(SessionMessageTable.seq, compaction),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

/** The `seq` of the chat's latest completed compaction, which the model's view starts after. */
export const latestCompaction = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID) {
  return (yield* newestCompaction(db, sessionID))?.seq
})

/**
 * The chat's latest completed compaction: its `seq`, its summary, and the `seq` of the first message it kept verbatim
 * (`metadata.keepID`, whose text the model sees in its recent part), when it kept any.
 */
export const newestCompaction = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID) {
  const row = yield* db
    .select({
      seq: SessionMessageTable.seq,
      summary: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.summary')`,
      keepID: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.keepID')`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "compaction"),
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const kept =
    typeof row.keepID === "string"
      ? yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.id, row.keepID as SessionMessage.ID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
      : undefined
  return {
    seq: row.seq,
    summary: typeof row.summary === "string" ? row.summary : "",
    kept: kept !== undefined && kept.seq < row.seq ? kept.seq : undefined,
  }
})

/** How many ids of entries in view are sent to be left out, the newest. */
const EXCLUDE = 100

/**
 * The ids of the entries the chat has in view, the newest first, at most {@link EXCLUDE}: those of its start blocks
 * and of the prompts' messages after its latest compaction and among the messages that compaction kept.
 */
export const inView = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID) {
  const compaction = yield* newestCompaction(db, sessionID)
  const rows = yield* db
    .select({
      block: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.memory')`,
      prompt: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.memoryPrompt.entries')`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "synthetic"),
        compaction === undefined
          ? undefined
          : compaction.kept === undefined
            ? gt(SessionMessageTable.seq, compaction.seq)
            : gte(SessionMessageTable.seq, compaction.kept),
        or(
          sql`json_extract(${SessionMessageTable.data}, '$.metadata.memory') is not null`,
          sql`json_extract(${SessionMessageTable.data}, '$.metadata.memoryPrompt') is not null`,
        ),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const ids = rows.flatMap((row) => {
    if (row.prompt !== null) return strings(row.prompt)
    const block = parsed(row.block)
    return typeof block === "object" && block !== null && "entries" in block
      ? [...strings(block.entries), ...("shown" in block ? strings(block.shown) : [])]
      : []
  })
  return [...new Set(ids)].slice(0, EXCLUDE)
})

/** SQLite's `json_extract` answers an object or an array as its JSON text. */
function parsed(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value
}

function strings(value: unknown) {
  const list = parsed(value)
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
}

/** The definitions without the memory tools this chat is not offered. */
export const apply = <T extends { readonly name: string }>(definitions: ReadonlyArray<T>, offer: Offered) =>
  definitions.filter(
    (definition) =>
      !tools.has(definition.name) || (definition.name === "task" ? offer.memory && offer.tasks : offer.memory),
  )
