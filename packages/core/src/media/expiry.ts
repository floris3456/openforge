export * as MediaExpiry from "./expiry.js"

import { PictureRemoved } from "@opencode/util/picture-removed"
import { and, asc, eq, gt, gte, isNull, lt, min, ne, or, type SQL, sql } from "drizzle-orm"
import { Effect } from "effect"
import { map } from "effect/Array"
import type { Tool } from "@opencode/schema/tool"
import type { Database } from "../database/database.js"
import { ImageTable } from "../image/sql.js"
import { SessionBlob } from "../session/blob.js"
import { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionInboxTable, SessionMessageTable, SessionPartTable, SessionTable } from "../session/sql.js"
import type { SessionStored } from "../session/stored.js"
import { MediaFiles } from "./files.js"
import { MediaClearedTable } from "./sql.js"

// openforge (spec pictures-files): a chat untouched for 30 days loses its pictures. Each picture in its messages, tool
// results and queued prompts becomes the placeholder text, its refs and its bank's originals go, and the files no other
// chat names are deleted. Only pictures go; other files stay.

type DatabaseService = Database.Interface["db"]
type MessageRow = typeof SessionMessageTable.$inferSelect
type InboxRow = typeof SessionInboxTable.$inferSelect
type Part = typeof SessionPartTable.$inferSelect.data

/** How long a chat stays untouched before its pictures go. */
export const AGE = 30 * 24 * 60 * 60 * 1000

/** The bank's ref to a chat's originals (ImageBank). */
const BANK = SessionMessage.ID.make("msg_image_bank")

/** Messages read per statement of one chat. */
const PAGE = 50

/**
 * Removes the pictures of every chat whose last change is `AGE` before `now` and that wasn't gone through since. Returns
 * when the next chat turns `AGE` old, or undefined when no chat will. `between` runs before each chat.
 */
export const run = Effect.fnUntraced(function* (
  db: DatabaseService,
  folder: string | undefined,
  now: number,
  between: Effect.Effect<void>,
) {
  const cutoff = now - AGE
  const due = yield* db
    .select({ id: SessionTable.id, time_updated: SessionTable.time_updated })
    .from(SessionTable)
    .leftJoin(MediaClearedTable, eq(MediaClearedTable.session_id, SessionTable.id))
    .where(
      and(
        lt(SessionTable.time_updated, cutoff),
        or(isNull(MediaClearedTable.time_updated), ne(MediaClearedTable.time_updated, SessionTable.time_updated)),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  for (const chat of due) {
    yield* between
    yield* clear(db, folder, chat, now)
  }
  const next = yield* db
    .select({ at: min(SessionTable.time_updated) })
    .from(SessionTable)
    .where(gte(SessionTable.time_updated, cutoff))
    .get()
    .pipe(Effect.orDie)
  return next?.at === null || next?.at === undefined ? undefined : next.at + AGE
})

/** One chat: its messages, its queued prompts and its bank, then the files nothing names any more. */
const clear = Effect.fnUntraced(function* (
  db: DatabaseService,
  folder: string | undefined,
  chat: { readonly id: SessionSchema.ID; readonly time_updated: number },
  since: number,
) {
  const gone: string[] = []
  const cursor = { seq: -1 }
  while (true) {
    const page = yield* db
      .select({
        id: SessionMessageTable.id,
        seq: SessionMessageTable.seq,
        found: sql<number>`(${media(sql`${SessionMessageTable.data}`)} OR EXISTS (SELECT 1 FROM session_part p WHERE p.message_id = ${SessionMessageTable.id} AND ${media(sql.raw("p.data"))}))`,
      })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, chat.id), gt(SessionMessageTable.seq, cursor.seq)))
      .orderBy(asc(SessionMessageTable.seq))
      .limit(PAGE)
      .all()
      .pipe(Effect.orDie)
    if (page.length === 0) break
    for (const row of page) if (row.found) gone.push(...(yield* clearMessage(db, row.id)))
    cursor.seq = page.at(-1)!.seq
    yield* Effect.yieldNow
  }
  const inbox = yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(eq(SessionInboxTable.session_id, chat.id))
    .all()
    .pipe(Effect.orDie)
  for (const row of inbox) gone.push(...(yield* clearInbox(db, row.id)))
  gone.push(
    ...(yield* db
      .transaction(() =>
        Effect.gen(function* () {
          // A number of the bank whose original went keeps its name and sizes; `image.show` says it was removed.
          yield* db.update(ImageTable).set({ hash: "" }).where(eq(ImageTable.session_id, chat.id)).run()
          yield* db
            .insert(MediaClearedTable)
            .values({ session_id: chat.id, time_updated: chat.time_updated })
            .onConflictDoUpdate({ target: MediaClearedTable.session_id, set: { time_updated: chat.time_updated } })
            .run()
          return yield* SessionBlob.releaseStale(db, { sessionID: chat.id, messageID: BANK }, new Set())
        }),
      )
      .pipe(Effect.orDie)),
  )
  if (folder)
    yield* Effect.forEach(new Set(gone), (hash) => Effect.promise(() => MediaFiles.remove(folder, hash, since)), {
      discard: true,
    })
})

// Whether a row's JSON may name a picture: a ref, or one inline.
const media = (column: SQL) =>
  sql`(instr(${column}, 'media:') > 0 OR instr(${column}, ';base64,') > 0 OR instr(${column}, '"data":"') > 0)`

/** One message and its parts, read and rewritten in one transaction; returns the hashes whose blob went. */
const clearMessage = (db: DatabaseService, id: SessionMessage.ID) =>
  db
    .transaction(() =>
      Effect.gen(function* () {
        const row = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get()
        if (!row) return []
        const parts =
          row.type === "assistant"
            ? yield* db.select().from(SessionPartTable).where(eq(SessionPartTable.message_id, id)).all()
            : []
        const data = clearData(row.data)
        const cleared = parts.map((part) => ({ part, data: clearData(part.data) }))
        if (data === row.data && cleared.every((item) => item.data === item.part.data)) return []
        if (data !== row.data)
          yield* db
            .update(SessionMessageTable)
            .set({ data, time_updated: row.time_updated })
            .where(eq(SessionMessageTable.id, id))
            .run()
        for (const item of cleared)
          if (item.data !== item.part.data)
            yield* db
              .update(SessionPartTable)
              .set({ data: item.data, time_updated: item.part.time_updated })
              .where(and(eq(SessionPartTable.message_id, id), eq(SessionPartTable.ordinal, item.part.ordinal)))
              .run()
        const present = new Set(
          [data, ...cleared.map((item) => item.data)].flatMap((value) => [...SessionBlob.hashesOf(value)]),
        )
        return yield* SessionBlob.releaseStale(db, { sessionID: row.session_id, messageID: id }, present)
      }),
    )
    .pipe(Effect.orDie)

const clearInbox = (db: DatabaseService, id: SessionMessage.ID) =>
  db
    .transaction(() =>
      Effect.gen(function* () {
        const row = yield* db.select().from(SessionInboxTable).where(eq(SessionInboxTable.id, id)).get()
        if (!row) return []
        const payload = clearData(row.payload)
        if (payload === row.payload) return []
        yield* db.update(SessionInboxTable).set({ payload }).where(eq(SessionInboxTable.id, id)).run()
        return yield* SessionBlob.releaseStale(
          db,
          { sessionID: row.session_id, messageID: id },
          SessionBlob.hashesOf(payload),
        )
      }),
    )
    .pipe(Effect.orDie)

const isPicture = (mime: string) => mime.startsWith("image/")

/** A stored row, inbox payload or part with each picture replaced by the placeholder; itself when it holds none. */
export function clearData<T extends MessageRow["data"] | InboxRow["payload"] | Part>(data: T): T {
  if ("files" in data && data.files?.some((file) => isPicture(file.mime)))
    return { ...data, files: data.files.map((file) => (isPicture(file.mime) ? removedFile(file) : file)) }
  if ("content" in data && Array.isArray(data.content) && data.content.some(holdsPicture))
    return { ...data, content: data.content.map(clearTool) }
  if ("type" in data && data.type === "tool" && holdsPicture(data)) return clearTool(data) as T
  return data
}

/** A person's picture becomes a text attachment of its name that says it was removed. */
const removedFile = (file: SessionStored.File): SessionStored.File => ({
  source: file.source,
  ...(file.name !== undefined && { name: file.name }),
  ...(file.description !== undefined && { description: file.description }),
  ...(file.mention !== undefined && { mention: file.mention }),
  mime: "text/plain",
  data: PictureRemoved.data,
})

const settled = (part: Part) =>
  part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")

const holdsPicture = (part: Part) =>
  settled(part) &&
  part.type === "tool" &&
  "content" in part.state &&
  (part.state.content ?? []).some((item) => item.type === "file" && isPicture(item.mime))

/** A tool's picture becomes a text item that says it was removed, after the picture's line. */
function clearTool(part: Part): Part {
  if (
    !holdsPicture(part) ||
    part.type !== "tool" ||
    (part.state.status !== "completed" && part.state.status !== "error")
  )
    return part
  const content = part.state.content
  if (!content) return part
  return {
    ...part,
    state: {
      ...part.state,
      content: map(
        content,
        (item): Tool.Content =>
          item.type === "file" && isPicture(item.mime) ? { type: "text", text: PictureRemoved.text } : item,
      ),
    },
  }
}
