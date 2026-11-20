export * as MediaFiles from "./files.js"

import { randomUUID } from "node:crypto"
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, utimes } from "node:fs/promises"
import path from "node:path"

// openforge (spec pictures-files): a picture's bytes as a file named by their SHA-256, in a folder beside the database
// that holds its reference. A file never changes once written, so a copy of the database needs only the names.

/** The folder of a database file: `media` beside `opencode.db`, `<name>-media` beside any other. */
export const folderFor = (database: string) => {
  const name = path.basename(database, ".db")
  return path.join(path.dirname(database), name === "opencode" ? "media" : `${name}-media`)
}

// The folder of each database service's connection; one without a folder (in memory, a Durable Object) keeps bytes in
// its rows.
const folders = new WeakMap<object, string>()

export const register = (db: object, folder: string) => {
  folders.set(db, folder)
}

export const folder = (db: object): string | undefined => folders.get(db)

export const file = (folder: string, hash: string) => path.join(folder, hash.slice(0, 2), hash)

// A file being written or removed carries one of these after its name; the sweep deletes old ones.
const WRITING = ".partial"
const REMOVING = ".removing"

/**
 * Makes sure the file of `hash` holds `bytes`. An existing one of their size is only touched, so a removal that is
 * about to delete it keeps it; any other is written whole under another name, synced, renamed, and its folder synced,
 * so once this returns the bytes are on disk.
 */
export async function put(folder: string, hash: string, bytes: Uint8Array) {
  const target = file(folder, hash)
  const now = new Date()
  const kept = await utimes(target, now, now)
    .then(() => stat(target))
    .catch(missing)
  if (kept && kept.size === bytes.byteLength) return
  const directory = path.dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}${WRITING}`
  const handle = await open(temporary, "w", 0o600)
  await handle
    .writeFile(bytes)
    .then(() => handle.sync())
    .finally(() => handle.close())
  await rename(temporary, target)
  const parent = await open(directory, "r")
  await parent.sync().finally(() => parent.close())
}

/** The bytes of `hash`'s file, or undefined when it can't be read. */
export const read = (folder: string, hash: string) =>
  readFile(file(folder, hash)).then(
    (bytes): Uint8Array | undefined => bytes,
    () => undefined,
  )

/**
 * Deletes `hash`'s file unless it was touched at or after `since` (milliseconds; a second's leeway for the file
 * system's coarse clock). It is renamed first, so a save meanwhile finds it missing and writes it again, and one just
 * before shows in its time, which puts it back. True when it was deleted.
 */
export async function remove(folder: string, hash: string, since: number) {
  const target = file(folder, hash)
  const aside = `${target}${REMOVING}`
  if (!(await rename(target, aside).then(() => true, missing))) return false
  const info = await stat(aside)
  if (info.mtimeMs >= since - 1000) {
    await rename(aside, target)
    return false
  }
  await unlink(aside)
  return true
}

/**
 * Every file of the folder: the hashes, and the leftovers of writes and removals that never finished (their paths).
 * An empty list for a folder that doesn't exist.
 */
export async function list(folder: string) {
  const shards = await readdir(folder).catch(() => [] as string[])
  const names = await Promise.all(
    shards
      .filter((shard) => /^[0-9a-f]{2}$/.test(shard))
      .map((shard) =>
        readdir(path.join(folder, shard)).then(
          (entries) => entries.map((entry) => ({ shard, entry })),
          () => [],
        ),
      ),
  )
  const all = names.flat()
  return {
    hashes: all.flatMap((item) => (/^[0-9a-f]{64}$/.test(item.entry) ? [item.entry] : [])),
    leftovers: all.flatMap((item) =>
      item.entry.endsWith(WRITING) || item.entry.endsWith(REMOVING) ? [path.join(folder, item.shard, item.entry)] : [],
    ),
  }
}

/** Deletes a leftover of `list` older than `before` (milliseconds). */
export const removeLeftover = (leftover: string, before: number) =>
  stat(leftover).then(
    (info) => (info.mtimeMs < before ? rm(leftover, { force: true }).then(() => true) : false),
    () => false,
  )

// Only a missing file is an answer; any other failure (a full disk, no permission) is one.
function missing(error: NodeJS.ErrnoException): false {
  if (error.code === "ENOENT") return false
  throw error
}
