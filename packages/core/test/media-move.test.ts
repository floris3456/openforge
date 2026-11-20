import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { asc, sql } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { SessionContinuity } from "@opencode/core/continuity"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"
import { MediaFiles } from "@opencode/core/media/files"
import { MediaKeeper } from "@opencode/core/media/keeper"
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
import { Tool } from "@opencode/schema/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
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
    executed: true,
    state: { status: "completed" as const, input: {}, content },
    time: { created: 2, ran: 2, completed: 2 },
  }
}

const layer = (file: string) =>
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionStore.node, KV.node, MediaKeeper.node]), [
    Database.node.replace(Database.configured({ path: file })),
    SessionContinuity.node.replace(SessionContinuity.noopLayer),
  ])

const seed = Effect.gen(function* () {
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
    })
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
        yield* seed
        const before = yield* reads

        expect(yield* MediaMove.run(db, folder, Effect.void)).toEqual({ blobs: 2, rows: 4 })

        yield* expectMoved(folder)
        expect(yield* reads).toEqual(before)
        // Nothing is left to move.
        expect(yield* MediaMove.run(db, folder, Effect.void)).toEqual({ blobs: 0, rows: 0 })
      }),
    ),
  )

  it.live("stopped partway, it goes on with what is left, and reads stay as they were throughout", () =>
    withDatabase((_, folder) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed
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
          const stopped = yield* MediaMove.run(db, folder, stopAt(n)).pipe(Effect.exit)
          expect(Exit.hasInterrupts(stopped)).toBe(true)
          expect(yield* reads).toEqual(before)
        }
        yield* MediaMove.run(db, folder, Effect.void)

        yield* expectMoved(folder)
        expect(yield* reads).toEqual(before)
      }),
    ),
  )

  it.live("a copy made as a release switch makes it holds none of the moved pictures", () =>
    withDatabase((file, folder) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed
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

        yield* MediaMove.run(db, folder, Effect.void)

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

  it.live("the service moves once per database and marks it done", () =>
    withDatabase((_, folder) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const keeper = yield* MediaKeeper.Service
        const kv = yield* KV.Service
        yield* seed

        yield* keeper.run

        yield* expectMoved(folder)
        expect(yield* kv.get(MediaKeeper.MOVED)).toMatchObject({ blobs: 2, rows: 4 })
        // Marked done, a later start doesn't scan again.
        const later = bytes(31, 1_000)
        yield* db
          .insert(BlobTable)
          .values({ hash: hash(later), mime: "image/png", bytes: later.byteLength, data: later, time_created: 1 })
          .run()
          .pipe(Effect.orDie)
        yield* keeper.run
        expect(
          yield* db.all<{ size: number }>(sql`SELECT length(data) AS size FROM blob WHERE hash = ${hash(later)}`),
        ).toEqual([{ size: later.byteLength }])
      }),
    ),
  )
})
