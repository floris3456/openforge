export * as ImageBank from "./bank.js"

import type { Entry } from "@opencode/schema/config"
import type { Tool } from "@opencode/schema/tool"
import { and, asc, eq, max } from "drizzle-orm"
import { Context, Effect, Option, Semaphore } from "effect"
import type { Config } from "../config.js"
import type { Database } from "../database/database.js"
import { SessionBlob } from "../session/blob.js"
import { SessionMessage } from "../session/message.js"
import type { SessionRunnerModel } from "../session/runner/model.js"
import type { SessionSchema } from "../session/schema.js"
import { BlobRefTable } from "../session/sql.js"
import { ImageFit } from "./fit.js"
import { ImageLine } from "@opencode/util/image-line"
import { ImageTable } from "./sql.js"

// A chat's image bank (spec images): while Settings › Session "Optimize images" is on and the chat's model has an entry
// in `ImageFit.MODELS`, each image arriving in it is fitted to the model once, numbered with one line before it, and its
// full-resolution original kept with the chat, for the `image` tool to show again or zoom into.

type DatabaseService = Database.Interface["db"]

/** `media.image.optimize` from the last config document that sets it; off by default. */
export const setting = (entries: ReadonlyArray<Entry>) =>
  entries
    .flatMap((entry) => (entry.type === "document" ? [entry.info.media?.image?.optimize] : []))
    .findLast((value) => value !== undefined) === true

/** The model's entry when a chat on it gets optimized images: the setting is on and the model has one. */
export const applies = (config: Option.Option<Config.Interface>, model: Pick<SessionRunnerModel.Resolved, "model">) => {
  const entry = ImageFit.forModel(model)
  if (!ImageFit.available || !entry || Option.isNone(config)) return Effect.succeed(undefined)
  return config.value.entries().pipe(Effect.map((entries) => (setting(entries) ? entry : undefined)))
}

/**
 * The chat a tool runs for, set by its request when the chat gets optimized images: its images then arrive once,
 * whole, at the tool's result, and the `image` tool reads the chat's bank.
 */
export const Current = Context.Reference<
  { readonly db: DatabaseService; readonly sessionID: SessionSchema.ID; readonly model: ImageFit.Model } | undefined
>("@opencode/ImageBank/Current", { defaultValue: () => undefined })

/** The line before an image, fixed on arrival. */
export const line = ImageLine.make

export interface Arrived extends ImageFit.Fitted {
  readonly number: number
  readonly line: string
}

// The blob_ref that keeps a banked original for as long as the chat; seq 0, so a revert never releases it.
const ORIGINAL_REF = SessionMessage.ID.make("msg_image_bank")
// Numbers come from one place, so images arriving at once never share one.
const numbering = Semaphore.makeUnsafe(1)

/**
 * Fits arriving images to the model, keeps each original in the chat's bank whatever `experimental.media_blob` says,
 * and numbers them in the order given. An image the chat already holds keeps its number and line, so showing one again
 * repeats it exactly. One that can't be decoded is undefined.
 */
export const arrive = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  model: ImageFit.Model,
  images: ReadonlyArray<{ readonly data: Uint8Array; readonly mime: string; readonly name: string }>,
) {
  const fitted = yield* Effect.forEach(
    images,
    (image) =>
      Effect.promise(() => ImageFit.convert(image.data, image.mime, model)).pipe(
        Effect.map((result) => result && { ...result, hash: SessionBlob.hashBytes(image.data), name: image.name }),
        Effect.tap((result) =>
          result
            ? SessionBlob.save(db, [
                {
                  hash: result.hash,
                  mime: image.mime,
                  bytes: image.data.byteLength,
                  width: result.width,
                  height: result.height,
                  data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
                },
              ])
            : Effect.void,
        ),
      ),
    { concurrency: 4 },
  )
  return yield* numbering.withPermits(1)(
    Effect.forEach(fitted, (image) => (image ? bank(db, sessionID, image) : Effect.succeed(undefined))),
  )
})

const bank = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  image: ImageFit.Fitted & { readonly hash: string; readonly name: string },
): Effect.fn.Return<Arrived> {
  const held = yield* db
    .select()
    .from(ImageTable)
    .where(and(eq(ImageTable.session_id, sessionID), eq(ImageTable.hash, image.hash)))
    .orderBy(asc(ImageTable.number))
    .get()
    .pipe(Effect.orDie)
  if (held) return { ...image, number: held.number, line: line(held.number, held.name, image) }
  const last = yield* db
    .select({ number: max(ImageTable.number) })
    .from(ImageTable)
    .where(eq(ImageTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const number = (last?.number ?? 0) + 1
  yield* db
    .insert(ImageTable)
    .values({
      session_id: sessionID,
      number,
      hash: image.hash,
      name: image.name,
      width: image.width,
      height: image.height,
      shown_width: image.shown.width,
      shown_height: image.shown.height,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(BlobRefTable)
    .values({ session_id: sessionID, message_id: ORIGINAL_REF, hash: image.hash, seq: 0 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return { ...image, number, line: line(number, image.name, image) }
})

const LINE_NUMBER = /\[Image (\d+): /g

/**
 * A fork's bank: the parent's images its copied history names by their lines, under the same numbers, their originals
 * kept for the fork too, so `image({ id })` works there as in the parent. `copied` is the fork's copied rows' data.
 */
export const fork = Effect.fnUntraced(function* (
  db: DatabaseService,
  parentID: SessionSchema.ID,
  sessionID: SessionSchema.ID,
  copied: ReadonlyArray<unknown>,
) {
  const named = new Set(
    copied.flatMap((data) => Array.from(JSON.stringify(data).matchAll(LINE_NUMBER), (match) => Number(match[1]))),
  )
  if (named.size === 0) return
  const images = (yield* list(db, parentID)).filter((image) => named.has(image.number))
  if (images.length === 0) return
  yield* db
    .insert(ImageTable)
    .values(images.map((image) => ({ ...image, session_id: sessionID })))
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(BlobRefTable)
    .values(
      [...new Set(images.map((image) => image.hash))].map((hash) => ({
        session_id: sessionID,
        message_id: ORIGINAL_REF,
        hash,
        seq: 0,
      })),
    )
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/** The chat's images, in number order. */
export const list = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(ImageTable)
    .where(eq(ImageTable.session_id, sessionID))
    .orderBy(asc(ImageTable.number))
    .all()
    .pipe(Effect.orDie)

/** The chat's image `number` with its original. */
export const get = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID, number: number) {
  const image = yield* db
    .select()
    .from(ImageTable)
    .where(and(eq(ImageTable.session_id, sessionID), eq(ImageTable.number, number)))
    .get()
    .pipe(Effect.orDie)
  if (!image) return undefined
  const original = yield* SessionBlob.read(db, image.hash)
  return original && { image, original }
})

const DATA_URI = /^data:[^,]*;base64,(.*)$/s

/**
 * A tool result's images arrived: each becomes its line and the fitted image. One that can't be decoded becomes a
 * note, as today; images that aren't inline pass unchanged.
 */
export const arriveContent = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  model: ImageFit.Model,
  tool: string,
  content: ReadonlyArray<Tool.Content>,
) {
  const inline = content.flatMap((item, index) => {
    if (item.type !== "file" || !item.mime.startsWith("image/")) return []
    const data = DATA_URI.exec(item.uri)?.[1]
    return data === undefined ? [] : [{ index, item, data }]
  })
  if (inline.length === 0) return content
  const arrived = yield* arrive(
    db,
    sessionID,
    model,
    inline.map((image) => ({
      data: Buffer.from(image.data, "base64"),
      mime: image.item.mime,
      name: image.item.name ?? `image from ${tool}`,
    })),
  )
  const byIndex = new Map(inline.map((image, position) => [image.index, arrived[position]]))
  return content.flatMap((item, index): ReadonlyArray<Tool.Content> => {
    if (item.type !== "file" || !byIndex.has(index)) return [item]
    const image = byIndex.get(index)
    if (!image) return [{ type: "text", text: "[1 image omitted: could not be decoded.]" }]
    return [
      { type: "text", text: image.line },
      { ...item, uri: `data:${image.mime};base64,${Buffer.from(image.data).toString("base64")}`, mime: image.mime },
    ]
  })
})
