// Half-typed prompts a TUI hands to itself when it restarts on a new release: written to a file only this user can
// read, named in the restarted process's environment, and read and removed once.
import { CarriedDraft } from "@opencode/tui"
import { Effect, FileSystem, Option, Schema } from "effect"
import path from "node:path"

export const variable = "OPENFORGE_TUI_DRAFTS"

const Drafts = Schema.Struct({ drafts: Schema.Array(CarriedDraft) })
const decodeDrafts = Schema.decodeUnknownOption(Schema.fromJsonString(Drafts))

/** Writes `drafts` for the restarted process; returns the file to name in its environment, if there is anything. */
export const keep = Effect.fnUntraced(function* (folder: string, drafts: ReadonlyArray<CarriedDraft>) {
  if (drafts.length === 0) return undefined
  const fs = yield* FileSystem.FileSystem
  const file = path.join(folder, `${process.pid}.json`)
  yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 })
  yield* fs.writeFileString(file, JSON.stringify({ drafts }), { mode: 0o600 })
  return file
})

/**
 * Takes the drafts the restarting process left: reads and removes the file `env` names, and the name. Only a file in
 * `folder` is read, so a stray variable cannot make this remove anything else.
 */
export const take = Effect.fnUntraced(function* (folder: string, env: Record<string, string | undefined>) {
  const file = env[variable]
  delete env[variable]
  if (!file || path.dirname(path.resolve(file)) !== path.resolve(folder)) return []
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file).pipe(Effect.option)
  yield* fs.remove(file).pipe(Effect.ignore)
  return Option.getOrUndefined(Option.flatMap(text, decodeDrafts))?.drafts ?? []
})

export * as TuiDrafts from "./tui-drafts"
