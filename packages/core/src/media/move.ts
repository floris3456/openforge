export * as MediaMove from "./move.js"

import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { SessionBlob } from "../session/blob.js"
import { BlobTable, SessionInboxTable, SessionMessageTable, SessionPartTable } from "../session/sql.js"
import { MediaFiles } from "./files.js"

// openforge (spec pictures-files): moves the media a database from before files holds in its rows into files, one row
// at a time. A row lets go of its bytes only once their file is whole on disk, so a stop at any point loses nothing and
// the next start goes on with what is left.

type DatabaseService = Database.Interface["db"]

/** Rows read per scan statement: a statement blocks the thread while it reads, and rows can be large. */
const PAGE = 50

/** What one run moved. */
export interface Moved {
  /** `blob` rows whose bytes went to their files. */
  readonly blobs: number
  /** Messages, parts and queued prompts whose inline media became refs. */
  readonly rows: number
}

/**
 * Moves every `blob` row's bytes into its file, then the media inline in messages, assistant parts and queued prompts.
 * `between` runs before each row, so the service can hold the move while it is paused.
 */
export const run = Effect.fnUntraced(function* (db: DatabaseService, folder: string, between: Effect.Effect<void>) {
  const blobs = yield* scan(db, "blob", sql`length(data) > 0`, (rowid) =>
    between.pipe(Effect.andThen(moveBlob(db, folder, rowid))),
  )
  const found = sql`(instr(data, ';base64,') > 0 OR instr(data, '"data":"') > 0)`
  const messages = yield* scan(db, "session_message", found, (rowid) =>
    between.pipe(Effect.andThen(moveMessage(db, folder, rowid))),
  )
  const parts = yield* scan(db, "session_part", found, (rowid) =>
    between.pipe(Effect.andThen(movePart(db, folder, rowid))),
  )
  const inbox = yield* scan(db, "session_inbox", sql`instr(payload, '"data":"') > 0`, (rowid) =>
    between.pipe(Effect.andThen(moveInbox(db, folder, rowid))),
  )
  return { blobs, rows: messages + parts + inbox } satisfies Moved
})

/** Runs `each` for every row of `table` that `where` picks, a page of rows per statement; sums what it returns. */
const scan = Effect.fnUntraced(function* (
  db: DatabaseService,
  table: string,
  where: ReturnType<typeof sql>,
  each: (rowid: number) => Effect.Effect<number>,
) {
  const state = { cursor: 0, total: 0 }
  while (true) {
    const page = yield* db
      .all<{
        rowid: number
        found: number
      }>(
        sql`SELECT rowid, ${where} AS found FROM ${sql.identifier(table)} WHERE rowid > ${state.cursor} ORDER BY rowid LIMIT ${PAGE}`,
      )
      .pipe(Effect.orDie)
    if (page.length === 0) return state.total
    for (const row of page) if (row.found) state.total += yield* each(row.rowid)
    state.cursor = page.at(-1)!.rowid
    yield* Effect.yieldNow
  }
})

const moveBlob = Effect.fnUntraced(function* (db: DatabaseService, folder: string, rowid: number) {
  const blob = yield* db
    .select({ hash: BlobTable.hash, data: BlobTable.data })
    .from(BlobTable)
    .where(sql`rowid = ${rowid}`)
    .get()
    .pipe(Effect.orDie)
  if (!blob || blob.data.byteLength === 0) return 0
  // Bytes that don't match their name stay in their row, which reads as it always did.
  if (SessionBlob.hashBytes(blob.data) !== blob.hash) {
    yield* Effect.logWarning("a stored picture's bytes don't match its hash; it stays in the database", {
      hash: blob.hash,
    })
    return 0
  }
  yield* Effect.promise(() => MediaFiles.put(folder, blob.hash, blob.data))
  yield* db
    .update(BlobTable)
    .set({ data: SessionBlob.EMPTY })
    .where(and(eq(BlobTable.hash, blob.hash), sql`length(${BlobTable.data}) > 0`))
    .run()
    .pipe(Effect.orDie)
  return 1
})

// A row's media is written to its files before the transaction, which holds the database; the transaction then
// rewrites the row only if nothing changed it meanwhile. Files of a row left as it was are swept a day later.

const moveMessage = Effect.fnUntraced(function* (db: DatabaseService, folder: string, rowid: number) {
  const row = yield* db
    .select({
      id: SessionMessageTable.id,
      session_id: SessionMessageTable.session_id,
      seq: SessionMessageTable.seq,
      time_updated: SessionMessageTable.time_updated,
      data: SessionMessageTable.data,
      text: sql<string>`data`,
    })
    .from(SessionMessageTable)
    .where(sql`rowid = ${rowid}`)
    .get()
    .pipe(Effect.orDie)
  if (!row) return 0
  const split = SessionBlob.split(row.data)
  if (!split.moved) return 0
  yield* write(folder, split.blobs)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const updated = yield* db
          .update(SessionMessageTable)
          .set({ data: split.data, time_updated: row.time_updated })
          .where(and(sql`rowid = ${rowid}`, sql`data = ${row.text}`))
          .returning({ id: SessionMessageTable.id })
          .get()
        if (!updated) return 0
        yield* SessionBlob.save(db, split.blobs)
        yield* SessionBlob.recordRefs(db, { sessionID: row.session_id, messageID: row.id, seq: row.seq }, split.data)
        return 1
      }),
    )
    .pipe(Effect.orDie)
})

const movePart = Effect.fnUntraced(function* (db: DatabaseService, folder: string, rowid: number) {
  const row = yield* db
    .select({
      message_id: SessionPartTable.message_id,
      session_id: SessionPartTable.session_id,
      seq: sql<number | null>`(SELECT seq FROM session_message WHERE id = ${SessionPartTable.message_id})`,
      time_updated: SessionPartTable.time_updated,
      data: SessionPartTable.data,
      text: sql<string>`data`,
    })
    .from(SessionPartTable)
    .where(sql`rowid = ${rowid}`)
    .get()
    .pipe(Effect.orDie)
  if (!row || row.seq === null) return 0
  const seq = row.seq
  const split = SessionBlob.split(row.data)
  if (!split.moved) return 0
  yield* write(folder, split.blobs)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const updated = yield* db
          .update(SessionPartTable)
          .set({ data: split.data, time_updated: row.time_updated })
          .where(and(sql`rowid = ${rowid}`, sql`data = ${row.text}`))
          .returning({ id: SessionPartTable.message_id })
          .get()
        if (!updated) return 0
        yield* SessionBlob.save(db, split.blobs)
        yield* SessionBlob.recordRefs(db, { sessionID: row.session_id, messageID: row.message_id, seq }, split.data)
        return 1
      }),
    )
    .pipe(Effect.orDie)
})

const moveInbox = Effect.fnUntraced(function* (db: DatabaseService, folder: string, rowid: number) {
  const row = yield* db
    .select({
      id: SessionInboxTable.id,
      session_id: SessionInboxTable.session_id,
      enqueued_seq: SessionInboxTable.enqueued_seq,
      payload: SessionInboxTable.payload,
      text: sql<string>`payload`,
    })
    .from(SessionInboxTable)
    .where(sql`rowid = ${rowid}`)
    .get()
    .pipe(Effect.orDie)
  if (!row) return 0
  const split = SessionBlob.split(row.payload)
  if (!split.moved) return 0
  yield* write(folder, split.blobs)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const updated = yield* db
          .update(SessionInboxTable)
          .set({ payload: split.data })
          .where(and(sql`rowid = ${rowid}`, sql`payload = ${row.text}`))
          .returning({ id: SessionInboxTable.id })
          .get()
        if (!updated) return 0
        yield* SessionBlob.save(db, split.blobs)
        yield* SessionBlob.recordRefs(
          db,
          { sessionID: row.session_id, messageID: row.id, seq: row.enqueued_seq },
          split.data,
        )
        return 1
      }),
    )
    .pipe(Effect.orDie)
})

const write = (folder: string, blobs: ReadonlyArray<typeof BlobTable.$inferInsert>) =>
  Effect.forEach(blobs, (blob) => Effect.promise(() => MediaFiles.put(folder, blob.hash, blob.data)), {
    discard: true,
  })
