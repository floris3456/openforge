// The database copies a release switch makes and restores. The CLI must not depend on Core, so this reads
// the database's own `migration` journal with SQLite directly instead of asking Core for its migrations.

import type { Database } from "bun:sqlite"
import { Effect, FileSystem, Option } from "effect"
import path from "node:path"
import { errorMessage } from "../util/error"
import { UpgradeError } from "./release"

/** Writes a consistent copy of `database` to `target` with SQLite's `VACUUM INTO`. False when there is no database. */
export const copy = Effect.fn("upgrade.database.copy")(function* (database: string, target: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(database))) return false
  const temporary = `${target}.partial`
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  yield* fs.remove(temporary, { force: true })
  yield* sqlite(database, (db) => {
    db.run("VACUUM INTO ?", [temporary])
  })
  // A copy in rollback-journal mode can be read later without creating -wal and -shm files beside it.
  yield* sqlite(temporary, (db) => {
    db.run("PRAGMA journal_mode = DELETE")
  })
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

/** Deletes `database` and its sidecars, for a rollback to a release that ran before any database existed. */
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

export * as ReleaseDatabase from "./database"
