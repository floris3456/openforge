export * as MemoryOffer from "./offer.js"

import { and, desc, eq, gt, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
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
  const row = yield* db
    .select({ seq: SessionMessageTable.seq })
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
  return row?.seq
})

/** The definitions without the memory tools this chat is not offered. */
export const apply = <T extends { readonly name: string }>(definitions: ReadonlyArray<T>, offer: Offered) =>
  definitions.filter(
    (definition) =>
      !tools.has(definition.name) || (definition.name === "task" ? offer.memory && offer.tasks : offer.memory),
  )
