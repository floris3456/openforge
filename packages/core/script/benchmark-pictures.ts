// What a release switch's database copy costs on a database of theorysnap's shape (spec pictures-files), before its
// pictures move to files and after, and how long the move takes. theorysnap, 2026-11-20: 31,940 originals in `blob`
// (21,282 JPEG of 365 KB, 10,658 PNG of 903 KB on average), 25,869 of 161,423 assistant rows holding fitted pictures
// inline (6.6 GB of Base64), 2,019 small user rows, 589 chats. The copy is `ReleaseDatabase.copy`'s two statements
// (packages/cli/src/upgrade/database.ts); the move is the service's own (MediaMove).
// With --seed-only it stops once the database is seeded, its pictures still in rows: the seed of the move's load
// measurement (task ze433w6fask0, run/evidence/pictures-files/move-load/harness).
//   bun run script/benchmark-pictures.ts <empty directory> [--scale 1] [--seed-only]
import { Database as Sqlite } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Global } from "@opencode/util/global"
import { Database } from "../src/database/database"
import { MediaFiles } from "../src/media/files"
import { MediaGate } from "../src/media/gate"
import { MediaMove } from "../src/media/move"

const args = process.argv.slice(2)
const directory = args[0]
if (!directory || directory.startsWith("--"))
  throw new Error("usage: benchmark-pictures.ts <empty directory> [--scale 1]")
const scale = Number(args[args.indexOf("--scale") + 1] ?? 1) || 1
await mkdir(directory, { recursive: true })
if ((await readdir(directory)).length > 0) throw new Error(`${directory} is not empty`)
const database = path.join(directory, "opencode.db")
const global = Global.make({ data: directory })
const count = (n: number) => Math.max(1, Math.round(n * scale))
const KB = 1024
const GB = 1024 ** 3

// The schema, through the migrations the service runs.
await Effect.runPromise(
  Effect.scoped(Layer.build(Database.layer({ path: database }))).pipe(Effect.provideService(Global.Service, global)),
)

const seeded = performance.now()
const db = new Sqlite(database)
db.run("PRAGMA synchronous = OFF")
const now = Date.now()
const chats = Array.from({ length: count(589) }, (_, index) => `ses_bench_${String(index).padStart(5, "0")}`)
db.run(
  "INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/', '[]', 0, 0)",
)
const chat = db.prepare(
  "INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', ?, '/project', ?, 'bench', ?, ?)",
)
// Every chat touched within 20 days, so none is old enough to lose its pictures: only the move changes the database.
db.transaction(() =>
  chats.forEach((id, index) => chat.run(id, id, `chat ${index}`, now, now - (index % 20) * 86_400_000)),
)()

const between = (low: number, high: number) => Math.round(low + Math.random() * (high - low))
const seq = new Map<string, number>()
const next = (id: string) => {
  const value = (seq.get(id) ?? 0) + 1
  seq.set(id, value)
  return value
}
const batched = <T>(items: number, make: (index: number) => T, insert: (item: T) => void) => {
  for (let start = 0; start < items; start += 500)
    db.transaction(() => {
      for (let index = start; index < Math.min(items, start + 500); index++) insert(make(index))
    })()
}

// The bank's originals, each kept by one chat's bank ref and numbered in it.
const blob = db.prepare(
  "INSERT INTO blob (hash, mime, bytes, width, height, data, time_created) VALUES (?, ?, ?, 2000, 1500, ?, ?)",
)
const ref = db.prepare("INSERT INTO blob_ref (session_id, message_id, hash, seq) VALUES (?, 'msg_image_bank', ?, 0)")
const image = db.prepare(
  "INSERT INTO session_image (session_id, number, hash, name, width, height, shown_width, shown_height, time_created) VALUES (?, ?, ?, ?, 2000, 1500, 1568, 1176, ?)",
)
const jpegs = count(21_282)
const pngs = count(10_658)
const numbers = new Map<string, number>()
batched(
  jpegs + pngs,
  (index) => {
    const jpeg = index < jpegs
    const data = randomBytes(jpeg ? between(150 * KB, 580 * KB) : between(400 * KB, 1406 * KB))
    return { chat: chats[index % chats.length]!, jpeg, data, hash: createHash("sha256").update(data).digest("hex") }
  },
  (item) => {
    blob.run(item.hash, item.jpeg ? "image/jpeg" : "image/png", item.data.byteLength, item.data, now)
    ref.run(item.chat, item.hash)
    const number = (numbers.get(item.chat) ?? 0) + 1
    numbers.set(item.chat, number)
    image.run(item.chat, number, item.hash, `shot ${number}.png`, now)
  },
)

const message = db.prepare(
  "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
)
const assistant = (content: unknown[]) =>
  JSON.stringify({
    agent: "build",
    model: { id: "claude-opus-4-8", providerID: "anthropic" },
    content,
    time: { created: now, completed: now },
  })
const filler = "The change keeps the cache warm and the chat where it was. ".repeat(160)
// Assistant rows: one in about six holds a fitted picture the model got, inline; the others are text.
const assistants = count(161_423)
const pictured = count(25_869)
const every = assistants / pictured
batched(
  assistants,
  (index) => {
    const id = chats[index % chats.length]!
    const withPicture = Math.floor(index % every) === 0
    const content = withPicture
      ? [
          {
            type: "tool",
            id: `call_${index}`,
            name: "screenshot",
            state: {
              status: "completed",
              input: {},
              content: [
                {
                  type: "text",
                  text: `[Image ${index}: shot.png, 2000×1500, shown at 1568×1176; see it again or zoom with image]`,
                },
                {
                  type: "file",
                  uri: `data:image/png;base64,${randomBytes(between(60 * KB, 320 * KB)).toString("base64")}`,
                  mime: "image/png",
                },
              ],
            },
            time: { created: now, ran: now, completed: now },
          },
        ]
      : [{ type: "text", text: filler.slice(0, between(2 * KB, 12 * KB)) }]
    return { id, content }
  },
  (item) => {
    const value = next(item.id)
    message.run(`msg_${item.id}_${value}`, item.id, "assistant", value, now, now, assistant(item.content))
  },
)
batched(
  count(2_019),
  (index) => chats[index % chats.length]!,
  (id) => {
    const value = next(id)
    message.run(
      `msg_${id}_${value}`,
      id,
      "user",
      value,
      now,
      now,
      JSON.stringify({ text: "Look at this.", time: { created: now } }),
    )
  },
)
db.run("PRAGMA wal_checkpoint(TRUNCATE)")
db.close()
const seedMs = Math.round(performance.now() - seeded)
if (args.includes("--seed-only")) {
  console.log(
    JSON.stringify({ scale, seed: { ms: seedMs, gb: Math.round(((await stat(database)).size / GB) * 100) / 100 } }),
  )
  process.exit(0)
}

/** A switch's copy: `VACUUM INTO`, then the copy in rollback-journal mode. */
const copy = async (name: string) => {
  const target = path.join(directory, name)
  const started = performance.now()
  const live = new Sqlite(database)
  live.run("VACUUM INTO ?", [target])
  live.close()
  const copied = new Sqlite(target)
  copied.run("PRAGMA journal_mode = DELETE")
  copied.close()
  return { ms: Math.round(performance.now() - started), bytes: (await stat(target)).size, target }
}

const size = async () => (await stat(database)).size
const seed = { ms: seedMs, bytes: await size() }
const before = await copy("copy-before.db")
await rm(before.target)

const moved = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const folder = MediaFiles.folder(db)
      if (!folder) throw new Error("no media folder")
      const started = performance.now()
      const result = yield* MediaMove.run(db, folder, MediaGate.here(Effect.void))
      return { ...result, ms: Math.round(performance.now() - started) }
    }).pipe(Effect.provide(Database.layer({ path: database }))),
  ).pipe(Effect.provideService(Global.Service, global)),
)
const live = await size()
const after = await copy("copy-after.db")
// The switch then puts its copy in place of the live database, which is mostly free space (ReleaseDatabase.shrink).
const shrinkStarted = performance.now()
await copyFile(after.target, `${database}.restore`)
await Promise.all(["-wal", "-shm", "-journal"].map((suffix) => rm(database + suffix, { force: true })))
await rename(`${database}.restore`, database)
const shrinkMs = Math.round(performance.now() - shrinkStarted)

const gb = (bytes: number) => Math.round((bytes / GB) * 100) / 100
console.log(
  JSON.stringify(
    {
      scale,
      seed: { ms: seed.ms, gb: gb(seed.bytes) },
      before: { copyMs: before.ms, copyGb: gb(before.bytes) },
      move: { ...moved, liveGbAfter: gb(live) },
      after: { copyMs: after.ms, copyGb: gb(after.bytes), shrinkMs, liveGb: gb(await size()) },
      files: (await MediaFiles.list(path.join(directory, "media"))).hashes.length,
    },
    null,
    2,
  ),
)
