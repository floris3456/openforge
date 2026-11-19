// The database copies a release switch makes and restores. The CLI must not depend on Core, so this reads
// the database's own `migration` journal with SQLite directly instead of asking Core for its migrations.

import type { Database } from "bun:sqlite"
import { Effect, FileSystem, Option } from "effect"
import path from "node:path"
import { errorMessage } from "../util/error"
import type { Reply, Request } from "./database-worker"
import { UpgradeError } from "./release"

/** Writes a consistent copy of `database` to `target` with SQLite's `VACUUM INTO`. False when there is no database. */
export const copy = Effect.fn("upgrade.database.copy")(function* (database: string, target: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(database))) return false
  const temporary = `${target}.partial`
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  yield* remove(temporary)
  // A failed copy is removed too: it can be nearly as large as the database.
  yield* Effect.gen(function* () {
    yield* inWorker(database, "VACUUM INTO ?", [temporary])
    // A copy in rollback-journal mode can be read later without creating -wal and -shm files beside it.
    yield* inWorker(temporary, "PRAGMA journal_mode = DELETE")
  }).pipe(Effect.tapError(() => remove(temporary).pipe(Effect.ignore)))
  yield* fs.rename(temporary, target)
  return true
})

/** Puts `source` in place of `database`. Every process using the database must have stopped. */
export const restore = Effect.fn("upgrade.database.restore")(function* (source: string, database: string) {
  const fs = yield* FileSystem.FileSystem
  const temporary = `${database}.restore`
  yield* fs.copyFile(source, temporary)
  // The sidecars belong to the database being replaced; SQLite would replay its WAL onto the restored file.
  yield* Effect.forEach(["-wal", "-shm", "-journal"], (suffix) => fs.remove(database + suffix, { force: true }))
  yield* fs.rename(temporary, database)
})

/**
 * Deletes `database` and its sidecars: for a rollback to a release that ran before any database existed, and for what a
 * copy left.
 */
export const remove = Effect.fn("upgrade.database.remove")(function* (database: string) {
  const fs = yield* FileSystem.FileSystem
  yield* Effect.forEach(["", "-wal", "-shm", "-journal"], (suffix) => fs.remove(database + suffix, { force: true }))
})

/** The ids recorded in the database's `migration` journal; undefined when the file does not exist. */
export const migrations = Effect.fn("upgrade.database.migrations")(function* (database: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(database))) return undefined
  return yield* sqlite(database, (db) => {
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'").get()
    if (!table) return []
    return db
      .query<{ id: string }, []>("SELECT id FROM migration")
      .all()
      .map((row) => row.id)
  })
})

/** When the copy at `file` was made, or undefined when there is none. */
export const madeAt = Effect.fn("upgrade.database.made-at")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const info = yield* fs.stat(file).pipe(Effect.option)
  return Option.getOrUndefined(Option.flatMap(info, (value) => value.mtime))
})

// bun:sqlite loads only when a switch needs it, so the CLI's startup never pays for it.
function sqlite<A>(file: string, use: (db: Database) => A) {
  return Effect.tryPromise({
    try: async () => {
      const { Database } = await import("bun:sqlite")
      using db = new Database(file)
      return use(db)
    },
    catch: (cause) => new UpgradeError({ reason: `could not use the database ${file}: ${errorMessage(cause)}` }),
  })
}

// A copy's statements run on a thread of their own: VACUUM INTO takes about 6 s per GB, and on this thread it would
// stop the switch lock's heartbeat, so that other processes took the lock as stale and switched in the middle.
function inWorker(file: string, sql: string, params: ReadonlyArray<string> = []) {
  return Effect.tryPromise({
    try: async () => {
      const { Worker } = await import("node:worker_threads")
      const worker = new Worker(new URL("./database-worker.js", import.meta.url), {
        workerData: { file, sql, params } satisfies Request,
      })
      await new Promise<void>((resolve, reject) => {
        worker.once("message", (reply: Reply) =>
          reply.error === undefined ? resolve() : reject(new Error(reply.error)),
        )
        worker.once("error", reject)
        worker.once("exit", (code) => reject(new Error(`its worker exited with code ${code}`)))
      }).finally(() => worker.terminate())
    },
    catch: (cause) => new UpgradeError({ reason: `could not use the database ${file}: ${errorMessage(cause)}` }),
  })
}

export * as ReleaseDatabase from "./database"
