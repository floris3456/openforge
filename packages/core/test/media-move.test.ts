import { describe, expect } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { asc, sql } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { SessionContinuity } from "@opencode/core/continuity"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ImageBank } from "@opencode/core/image/bank"
import { ImageTable } from "@opencode/core/image/sql"
import { KV } from "@opencode/core/kv"
import { MediaFiles } from "@opencode/core/media/files"
import { MediaGate } from "@opencode/core/media/gate"
import { MediaKeeper } from "@opencode/core/media/keeper"
import { MediaClearedTable } from "@opencode/core/media/sql"
import { MediaExpiry } from "@opencode/core/media/expiry"
import { MediaMove } from "@opencode/core/media/move"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import {
  BlobRefTable,
  BlobTable,
  SessionInboxTable,
  SessionMessageTable,
  SessionPartTable,
  SessionTable,
} from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { ai } from "@opencode/ai/effect"
import { AnthropicMessages } from "@opencode/ai/protocols"
import { Auth } from "@opencode/ai/route"
import { compileRequest } from "@opencode/ai/testing"
import { Tool } from "@opencode/schema/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { PictureRemoved } from "@opencode/util/picture-removed"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// Pictures in the shapes a database from before files holds them (spec pictures-files): bank originals in `blob`,
// fitted pictures inline in an assistant row and in a session_part row, a person's file, a queued prompt's file.
const bytes = (seed: number, size: number) => {
  const state = { value: seed }
  return Buffer.from(
    Array.from({ length: size }, () => {
      state.value = (state.value * 1_103_515_245 + 12_345) % 2_147_483_648
      return state.value >> 23
    }),
  )
}
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")
const originals = [bytes(3, 40_000), bytes(5, 25_000)]
const fitted = bytes(11, 9_000)
const person = bytes(13, 7_000)
const part = bytes(17, 6_000)
const queued = bytes(19, 5_000)
// A data: URI whose type differs from its item's would read back as another text, so it stays inline.
const mismatched = `data:image/jpeg;base64,${bytes(23, 4_000).toString("base64")}`
// Bytes that don't match the hash they are stored under stay in their row.
const corrupt = { hash: "f".repeat(64), data: bytes(29, 3_000) }

const sessionID = Session.ID.make("ses_media_move")
const created = DateTime.makeUnsafe(0)
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

const assistant = (id: SessionMessage.ID, seq: number, content: ReadonlyArray<ReturnType<typeof tool>>) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({
      id,
      type: "assistant",
      agent: Agent.defaultID,
      model,
      content: [],
      time: { created, completed: created },
    }),
  )
  return { id, session_id: sessionID, type, seq, time_created: seq, time_updated: seq, data: { ...data, content } }
}

type Item = typeof Tool.Content.Encoded

function tool(id: string, content: readonly [Item, ...Item[]]) {
  return {
    type: "tool" as const,
    id,
    name: "screenshot",
    executed: false,
    state: { status: "completed" as const, input: {}, content },
    time: { created: 2, ran: 2, completed: 2 },
  }
}

const layer = (file: string) =>
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionStore.node, KV.node, MediaKeeper.node]), [
    Database.node.replace(Database.configured({ path: file })),
    SessionContinuity.node.replace(SessionContinuity.noopLayer),
  ])

/** The chat's rows, its last change at `updated` (now when not given). */
const seed = (updated?: number) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "s",
        directory: "/project",
        title: "s",
        version: "t",
        ...(updated === undefined ? {} : { time_updated: updated }),
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(ImageTable)
      .values(
        originals.map((data, index) => ({
          session_id: sessionID,
          number: index + 1,
          hash: hash(data),
          name: `original ${index + 1}`,
          width: 10,
          height: 10,
          shown_width: 10,
          shown_height: 10,
        })),
      )
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(BlobTable)
      .values([
        ...originals.map((data) => ({
          hash: hash(data),
          mime: "image/png",
          bytes: data.byteLength,
          data,
          time_created: 1,
        })),
        { ...corrupt, mime: "image/png", bytes: corrupt.data.byteLength, time_created: 1 },
      ])
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(BlobRefTable)
      .values(
        [...originals.map(hash), corrupt.hash].map((item) => ({
          session_id: sessionID,
          message_id: SessionMessage.ID.make("msg_image_bank"),
          hash: item,
          seq: 0,
        })),
      )
      .run()
      .pipe(Effect.orDie)
    const split = SessionMessage.ID.make("msg_move_split")
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.make("msg_move_user"),
          session_id: sessionID,
          type: "user",
          seq: 1,
          time_created: 1,
          time_updated: 1,
          data: {
            text: "look",
            files: [{ data: person.toString("base64"), mime: "image/png", source: { type: "inline" }, name: "me.png" }],
            time: { created: 1 },
          },
        },
        assistant(SessionMessage.ID.make("msg_move_inline"), 2, [
          tool("call_fitted", [
            { type: "text", text: "[Image 1: fitted]" },
            { type: "file", uri: `data:image/png;base64,${fitted.toString("base64")}`, mime: "image/png" },
            { type: "file", uri: mismatched, mime: "image/png" },
          ]),
        ]),
        assistant(split, 3, []),
      ])
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionPartTable)
      .values({
        message_id: split,
        session_id: sessionID,
        ordinal: 0,
        type: "tool",
        call_id: "call_part",
        time_created: 3,
        time_updated: 3,
        data: tool("call_part", [
          { type: "file", uri: `data:image/png;base64,${part.toString("base64")}`, mime: "image/png" },
        ]),
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionInboxTable)
      .values({
        id: SessionMessage.ID.make("msg_move_queued"),
        session_id: sessionID,
        type: "user",
        payload: {
          text: "later",
          files: [{ data: queued.toString("base64"), mime: "image/png", source: { type: "inline" }, name: "q.png" }],
        },
        delivery: "queue",
        enqueued_seq: 4,
        time_created: 4,
      })
      .run()
      .pipe(Effect.orDie)
  })

/** What a reader gets: the chat's messages and its queued prompts, with every picture inline. */
const reads = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const store = yield* SessionStore.Service
  return {
    messages: yield* store.messages({ sessionID, order: "asc" }),
    inbox: yield* SessionInbox.list(db, sessionID),
  }
})

/** Every picture is a file with the bytes of its name, and no row holds one but those that can't move. */
const expectMoved = Effect.fnUntraced(function* (folder: string) {
  const db = (yield* Database.Service).db
  const moved = [...originals, fitted, person, part, queued]
  expect(
    yield* db
      .all<{ hash: string; size: number }>(sql`SELECT hash, length(data) AS size FROM blob ORDER BY hash`)
      .pipe(Effect.orDie),
  ).toEqual(
    [
      ...moved.map((data) => ({ hash: hash(data), size: 0 })),
      { hash: corrupt.hash, size: corrupt.data.byteLength },
    ].toSorted((a, b) => a.hash.localeCompare(b.hash)),
  )
  for (const data of moved)
    expect(hash(yield* Effect.promise(() => readFile(MediaFiles.file(folder, hash(data)))))).toBe(hash(data))
  const rows = JSON.stringify([
    yield* db.select().from(SessionMessageTable).all().pipe(Effect.orDie),
    yield* db.select().from(SessionPartTable).all().pipe(Effect.orDie),
    yield* db.select().from(SessionInboxTable).all().pipe(Effect.orDie),
  ])
  for (const data of [fitted, person, part, queued]) expect(rows).not.toContain(data.toString("base64"))
  expect(rows).toContain(mismatched)
  expect(
    yield* db
      .select({ message: sql<string>`message_id`, hash: BlobRefTable.hash, seq: BlobRefTable.seq })
      .from(BlobRefTable)
      .orderBy(asc(BlobRefTable.seq), asc(BlobRefTable.hash))
      .all()
      .pipe(Effect.orDie),
  ).toEqual(
    [
      ...[...originals.map(hash), corrupt.hash].map((item) => ({ message: "msg_image_bank", hash: item, seq: 0 })),
      { message: "msg_move_user", hash: hash(person), seq: 1 },
      { message: "msg_move_inline", hash: hash(fitted), seq: 2 },
      { message: "msg_move_split", hash: hash(part), seq: 3 },
      { message: "msg_move_queued", hash: hash(queued), seq: 4 },
    ].toSorted((a, b) => a.seq - b.seq || a.hash.localeCompare(b.hash)),
  )
})

const withDatabase = <A, E>(
  body: (file: string, folder: string) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layer>>>,
) =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-media-move-")).path
    const file = path.join(dir, "opencode.db")
    return yield* body(file, path.join(dir, "media")).pipe(Effect.provide(layer(file)))
  })

describe("MediaMove", () => {
  it.live("moves every picture of a database from before files into files, and every read stays as it was", () =>
    withDatabase((_, folder) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed()
        const before = yield* reads

        expect(yield* MediaMove.run(db, folder, MediaGate.here(Effect.void))).toEqual({ blobs: 2, rows: 4 })

        yield* expectMoved(folder)
        expect(yield* reads).toEqual(before)
        // Nothing is left to move.
        expect(yield* MediaMove.run(db, folder, MediaGate.here(Effect.void))).toEqual({ blobs: 0, rows: 0 })
      }),
    ),
  )

  it.live("stopped partway, it goes on with what is left, and reads stay as they were throughout", () =>
    withDatabase((_, folder) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed()
        const before = yield* reads
        // A crash had left one picture's file whole and another's half written.
        const first = hash(originals[0]!)
        yield* Effect.promise(async () => {
          for (const item of [first, hash(fitted)])
            await mkdir(path.dirname(MediaFiles.file(folder, item)), { recursive: true })
          await writeFile(MediaFiles.file(folder, first), originals[0]!)
          await writeFile(`${MediaFiles.file(folder, hash(fitted))}.x.partial`, fitted.subarray(0, 10))
        })

        const calls = { count: 0 }
        const stopAt = (n: number) => Effect.suspend(() => (++calls.count === n ? Effect.interrupt : Effect.void))
        for (const n of [2, 4]) {
          calls.count = 0
          const stopped = yield* MediaMove.run(db, folder, MediaGate.here(stopAt(n))).pipe(Effect.exit)
          expect(Exit.hasInterrupts(stopped)).toBe(true)
          expect(yield* reads).toEqual(before)
        }
        yield* MediaMove.run(db, folder, MediaGate.here(Effect.void))

        yield* expectMoved(folder)
        expect(yield* reads).toEqual(before)
      }),
    ),
  )

  it.live("a copy made as a release switch makes it holds none of the moved pictures", () =>
    withDatabase((file, folder) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed()
        const moved = [...originals, fitted, person, part, queued]
        // ReleaseDatabase.copy (packages/cli/src/upgrade/database.ts) copies with this statement.
        const copy = Effect.fnUntraced(function* (name: string) {
          const target = path.join(path.dirname(file), name)
          yield* db.run(sql`VACUUM INTO ${target}`).pipe(Effect.orDie)
          const content = yield* Effect.promise(() => readFile(target))
          // SQLite spreads a large value over pages, so look for pieces short enough to sit whole in one.
          const pieces = (data: Buffer) =>
            Array.from({ length: Math.floor(data.byteLength / 256) }, (_, i) => data.subarray(i * 256, i * 256 + 256))
          return {
            size: content.byteLength,
            pictures: moved.filter((data) =>
              [...pieces(data), ...pieces(Buffer.from(data.toString("base64")))].some((piece) =>
                content.includes(piece),
              ),
            ).length,
          }
        })
        const before = yield* copy("before.db")
        expect(before.pictures).toBe(moved.length)

        yield* MediaMove.run(db, folder, MediaGate.here(Effect.void))

        const after = yield* copy("after.db")
        expect(after.pictures).toBe(0)
        // An empty database is most of a copy's size here: its tables' pages.
        const stored =
          originals.reduce((sum, data) => sum + data.byteLength, 0) +
          [fitted, person, part, queued].reduce((sum, data) => sum + data.toString("base64").length, 0)
        expect(before.size - after.size).toBeGreaterThan(stored * 0.9)
      }),
    ),
  )
})

const DAY = 24 * 60 * 60 * 1000

// What the model is sent: the chat's context lowered as the runner lowers it, compiled into Anthropic's request body.
const claude = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-opus-4-8" })
const body = Effect.gen(function* () {
  const store = yield* SessionStore.Service
  const messages = toLLMMessages(yield* store.context(sessionID), {
    id: Model.ID.make("claude-opus-4-8"),
    providerID: Provider.ID.make("anthropic"),
  })
  return JSON.stringify((yield* compileRequest(ai.request({ model: claude, messages, cache: "auto" }))).body)
})

describe("what the model is sent", () => {
  it.live("is the same bytes for a chat's pictures before and after the move", () =>
    withDatabase((_, folder) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed()
        const before = yield* body
        for (const data of [fitted, person, part]) expect(before).toContain(data.toString("base64"))

        yield* MediaMove.run(db, folder, MediaGate.here(Effect.void))

        expect(yield* body).toBe(before)
      }),
    ),
  )

  it.live("for a chat whose pictures were removed is the placeholder where each was, and it compiles", () =>
    withDatabase((_, folder) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const now = Date.now()
        yield* seed(now - 31 * DAY)

        yield* MediaExpiry.run(db, folder, now, MediaGate.here(Effect.void))

        const sent = yield* body
        for (const data of [fitted, person, part, ...originals]) expect(sent).not.toContain(data.toString("base64"))
        expect(sent).not.toContain(mismatched)
        expect(sent.split(PictureRemoved.text).length - 1).toBe(4)
      }),
    ),
  )
})
const warmID = Session.ID.make("ses_media_warm")
const warmPicture = bytes(37, 8_000)

/** Polls in real time until `check` holds, while the keeper works on its own fiber. */
const until = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const deadline = performance.now() + 10_000
    while (!(yield* check)) {
      if (performance.now() > deadline) return yield* Effect.die(new Error("it never happened within 10s"))
      yield* TestClock.withLive(Effect.sleep("10 millis"))
    }
  })

describe("MediaKeeper", () => {
  it.effect(
    "removes the pictures of a chat untouched for 30 days at open, of the next one when it turns 30 days old, and moves the rest once",
    () =>
      withDatabase((_, folder) =>
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const keeper = yield* MediaKeeper.Service
          const kv = yield* KV.Service
          // The files written now are 40 days older than the keeper's clock.
          const now = Date.now() + 40 * DAY
          yield* TestClock.setTime(now)
          yield* seed(now - 31 * DAY)
          // A chat touched 29 days ago that holds one of the cold chat's originals and a picture of its own.
          yield* db
            .insert(SessionTable)
            .values({
              id: warmID,
              project_id: Project.ID.global,
              slug: "w",
              directory: "/project",
              title: "w",
              version: "t",
              time_updated: now - 29 * DAY,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(BlobRefTable)
            .values({
              session_id: warmID,
              message_id: SessionMessage.ID.make("msg_image_bank"),
              hash: hash(originals[0]!),
              seq: 0,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make("msg_warm_user"),
              session_id: warmID,
              type: "user",
              seq: 1,
              time_created: 1,
              time_updated: 1,
              data: {
                text: "mine",
                files: [
                  {
                    data: warmPicture.toString("base64"),
                    mime: "image/png",
                    source: { type: "inline" },
                    name: "w.png",
                  },
                ],
                time: { created: 1 },
              },
            })
            .run()
            .pipe(Effect.orDie)
          const store = yield* SessionStore.Service
          const warmBefore = yield* store.messages({ sessionID: warmID, order: "asc" })
          const cleared = (id: Session.ID) =>
            db
              .select()
              .from(MediaClearedTable)
              .all()
              .pipe(
                Effect.orDie,
                Effect.map((rows) => rows.some((row) => row.session_id === id)),
              )

          const running = yield* keeper.run.pipe(Effect.forkChild({ startImmediately: true }))
          yield* until(kv.get(MediaKeeper.MOVED).pipe(Effect.map((value) => value !== undefined)))

          // The cold chat: each picture is the placeholder, in the model's view as in its rows.
          expect(yield* cleared(sessionID)).toBe(true)
          const after = yield* reads
          expect(after.messages).toMatchObject([
            {
              type: "user",
              files: [{ data: PictureRemoved.data, mime: "text/plain", name: "me.png", source: { type: "inline" } }],
            },
            {
              content: [
                {
                  state: {
                    content: [
                      { type: "text", text: "[Image 1: fitted]" },
                      { type: "text", text: PictureRemoved.text },
                      { type: "text", text: PictureRemoved.text },
                    ],
                  },
                },
              ],
            },
            { content: [{ state: { content: [{ type: "text", text: PictureRemoved.text }] } }] },
          ])
          expect(after.inbox).toMatchObject([
            { payload: { files: [{ data: PictureRemoved.data, mime: "text/plain", name: "q.png" }] } },
          ])
          expect(yield* db.select({ hash: ImageTable.hash }).from(ImageTable).all().pipe(Effect.orDie)).toEqual([
            { hash: "" },
            { hash: "" },
          ])
          // image.show of its numbers says the picture was removed.
          expect(yield* ImageBank.get(db, sessionID, 1)).toMatchObject({ image: { number: 1 }, original: undefined })
          // Its last change stays when it was: the removal doesn't touch the chat.
          expect(
            (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).map((row) => [row.id, row.time_updated]),
          ).toEqual([
            [sessionID, now - 31 * DAY],
            [warmID, now - 29 * DAY],
          ])
          // The original the warm chat holds stays, as a file; nothing else of the cold chat's pictures is left.
          expect(
            yield* db
              .all<{ hash: string; size: number }>(sql`SELECT hash, length(data) AS size FROM blob ORDER BY hash`)
              .pipe(Effect.orDie),
          ).toEqual(
            [
              { hash: hash(originals[0]!), size: 0 },
              { hash: hash(warmPicture), size: 0 },
            ].toSorted((a, b) => a.hash.localeCompare(b.hash)),
          )
          expect(yield* store.messages({ sessionID: warmID, order: "asc" })).toEqual(warmBefore)
          const files = () =>
            Effect.promise(() => MediaFiles.list(folder)).pipe(Effect.map((list) => list.hashes.toSorted()))
          expect(yield* files()).toEqual([hash(originals[0]!), hash(warmPicture)].toSorted())

          // A day later the warm chat turns 30 days old, and the timer set for that moment removes its pictures too.
          yield* TestClock.adjust(DAY + 1)
          yield* until(cleared(warmID))
          expect(yield* store.messages({ sessionID: warmID, order: "asc" })).toMatchObject([
            { files: [{ data: PictureRemoved.data, mime: "text/plain", name: "w.png" }] },
          ])
          yield* until(files().pipe(Effect.map((list) => list.length === 0)))
          expect(yield* db.select().from(BlobTable).all().pipe(Effect.orDie)).toEqual([])
          yield* Fiber.interrupt(running)

          // The move ran once: a later start doesn't scan again, while it still goes through chats.
          const later = bytes(31, 1_000)
          yield* db
            .insert(BlobTable)
            .values({ hash: hash(later), mime: "image/png", bytes: later.byteLength, data: later, time_created: 1 })
            .run()
            .pipe(Effect.orDie)
          yield* db.delete(MediaClearedTable).run().pipe(Effect.orDie)
          const again = yield* keeper.run.pipe(Effect.forkChild({ startImmediately: true }))
          yield* until(cleared(sessionID))
          yield* Fiber.interrupt(again)
          expect(
            yield* db
              .all<{ size: number }>(sql`SELECT length(data) AS size FROM blob WHERE hash = ${hash(later)}`)
              .pipe(Effect.orDie),
          ).toEqual([{ size: later.byteLength }])
        }),
      ),
  )

  // Budget (task ze433w6fask0): the move must hold the service's thread no longer than 50 ms at a time. Pictures this
  // large make the work on one row take over 100 ms, so a keeper that did it on the service's thread fails by far; with
  // the work on its worker the thread runs a few milliseconds between two ticks of a 5 ms timer. What counts is the
  // thread's own time on a CPU between two ticks (Linux's schedstat), so a loaded machine that leaves it waiting for a
  // CPU doesn't read as a block; other systems have no such count for one thread.
  ;(process.platform === "linux" ? it.live : it.live.skip)(
    "moves large pictures without holding the service's thread for more than 50 ms",
    () =>
      withDatabase((_, folder) =>
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const keeper = yield* MediaKeeper.Service
          const kv = yield* KV.Service
          yield* seed()
          const large = [randomBytes(24 * 1024 * 1024), randomBytes(24 * 1024 * 1024)]
          yield* db
            .insert(SessionMessageTable)
            .values(
              large.map((data, index) =>
                assistant(SessionMessage.ID.make(`msg_move_large_${index}`), 10 + index, [
                  tool(`call_large_${index}`, [
                    { type: "file", uri: `data:image/png;base64,${data.toString("base64")}`, mime: "image/png" },
                  ]),
                ]),
              ),
            )
            .run()
            .pipe(Effect.orDie)
          const original = randomBytes(24 * 1024 * 1024)
          yield* db
            .insert(BlobTable)
            .values({
              hash: hash(original),
              mime: "image/png",
              bytes: original.byteLength,
              data: original,
              time_created: 1,
            })
            .run()
            .pipe(Effect.orDie)

          const onCpu = () => Number(readFileSync("/proc/thread-self/schedstat", "utf8").split(" ")[0]) / 1e6
          const gaps = { last: onCpu(), longest: 0 }
          const sampler = setInterval(() => {
            const now = onCpu()
            gaps.longest = Math.max(gaps.longest, now - gaps.last)
            gaps.last = now
          }, 5)
          const running = yield* keeper.run.pipe(Effect.forkChild({ startImmediately: true }))
          const deadline = performance.now() + 60_000
          while ((yield* kv.get(MediaKeeper.MOVED)) === undefined) {
            if (performance.now() > deadline) return yield* Effect.die(new Error("the move didn't end within 60 s"))
            yield* Effect.sleep("20 millis")
          }
          clearInterval(sampler)
          yield* Fiber.interrupt(running)

          expect(yield* kv.get(MediaKeeper.MOVED)).toMatchObject({ blobs: 3, rows: 6 })
          for (const data of [...large, original])
            expect((yield* Effect.promise(() => readFile(MediaFiles.file(folder, hash(data))))).equals(data)).toBe(true)
          expect(gaps.longest).toBeLessThan(50)
        }),
      ),
  )

  // The worker writes over a connection of its own. A transaction of the service's that read before one of its writes
  // committed and writes after it would fail with SQLITE_BUSY_SNAPSHOT, so each of the worker's writes waits until it
  // holds the service's connection. Each transaction here reads, waits 3 ms and writes, while the worker moves 200 rows.
  it.live("never makes a transaction of the service's fail while it moves on its worker", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const keeper = yield* MediaKeeper.Service
        const kv = yield* KV.Service
        yield* seed()
        yield* db
          .insert(SessionMessageTable)
          .values(
            Array.from({ length: 200 }, (_, index) =>
              assistant(SessionMessage.ID.make(`msg_move_many_${index}`), 100 + index, [
                tool(`call_many_${index}`, [
                  {
                    type: "file",
                    uri: `data:image/png;base64,${bytes(100 + index, 16_000).toString("base64")}`,
                    mime: "image/png",
                  },
                ]),
              ]),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db.run(sql`CREATE TABLE service_writes (n INTEGER)`).pipe(Effect.orDie)

        const outcome = { ok: 0, failed: [] as string[] }
        const running = yield* keeper.run.pipe(Effect.forkChild({ startImmediately: true }))
        const deadline = performance.now() + 60_000
        while ((yield* kv.get(MediaKeeper.MOVED)) === undefined) {
          if (performance.now() > deadline) return yield* Effect.die(new Error("the move didn't end within 60 s"))
          const exit = yield* db
            .transaction(() =>
              Effect.gen(function* () {
                yield* db.get(sql`SELECT count(*) FROM service_writes`)
                yield* Effect.sleep("3 millis")
                yield* db.run(sql`INSERT INTO service_writes VALUES (1)`)
              }),
            )
            .pipe(Effect.exit)
          if (exit._tag === "Success") outcome.ok++
          else
            outcome.failed.push(
              Bun.inspect(Cause.squash(exit.cause)).match(/SQLITE_\w+/)?.[0] ?? Cause.pretty(exit.cause),
            )
        }
        yield* Fiber.interrupt(running)

        expect(yield* kv.get(MediaKeeper.MOVED)).toMatchObject({ blobs: 2, rows: 204 })
        expect(outcome.failed.slice(0, 3)).toEqual([])
        expect(outcome.ok).toBeGreaterThan(0)
      }),
    ),
  )
})
