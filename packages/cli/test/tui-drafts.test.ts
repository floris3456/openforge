import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { testEffect } from "../../core/test/lib/effect"
import { TuiDrafts } from "../src/tui-drafts"

const it = testEffect(NodeServices.layer)

const temporary = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "openforge-drafts-"))),
  (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
)

const draft = { sessionID: "ses_a", prompt: { text: "half a thought", pasted: [] }, cursor: 6 }
// The home screen's composer, with its cursor at the end.
const home = { prompt: { text: "a new chat", pasted: [], mode: "shell" as const }, cursor: null }

describe("drafts across a restart", () => {
  it.live("hands the drafts to the restarted process once, in a file only this user can read", () =>
    Effect.gen(function* () {
      const folder = path.join(yield* temporary, "state", "drafts")
      const file = yield* TuiDrafts.keep(folder, [draft, home])
      expect(file).toBe(path.join(folder, `${process.pid}.json`))
      if (!file) return
      const stat = yield* Effect.promise(() => fs.stat(file))
      expect(stat.mode & 0o777).toBe(0o600)
      expect((yield* Effect.promise(() => fs.stat(folder))).mode & 0o777).toBe(0o700)

      const env: Record<string, string | undefined> = { [TuiDrafts.variable]: file }
      expect(yield* TuiDrafts.take(folder, env)).toEqual([draft, home])
      expect(env[TuiDrafts.variable]).toBeUndefined()
      expect(yield* Effect.promise(() => fs.exists(file))).toBe(false)
      // A second start finds nothing.
      expect(yield* TuiDrafts.take(folder, { [TuiDrafts.variable]: file })).toEqual([])
    }),
  )

  it.live("writes nothing without drafts", () =>
    Effect.gen(function* () {
      const folder = path.join(yield* temporary, "drafts")
      expect(yield* TuiDrafts.keep(folder, [])).toBeUndefined()
      expect(yield* Effect.promise(() => fs.exists(folder))).toBe(false)
    }),
  )

  it.live("leaves a file outside its folder alone and ignores one it cannot read", () =>
    Effect.gen(function* () {
      const root = yield* temporary
      const folder = path.join(root, "drafts")
      const elsewhere = path.join(root, "notes.json")
      yield* Effect.promise(() => fs.writeFile(elsewhere, JSON.stringify({ drafts: [draft] })))
      expect(yield* TuiDrafts.take(folder, { [TuiDrafts.variable]: elsewhere })).toEqual([])
      expect(yield* Effect.promise(() => fs.exists(elsewhere))).toBe(true)
      expect(yield* TuiDrafts.take(folder, { [TuiDrafts.variable]: path.join(folder, "..", "notes.json") })).toEqual([])
      expect(yield* Effect.promise(() => fs.exists(elsewhere))).toBe(true)

      yield* Effect.promise(() => fs.mkdir(folder))
      const broken = path.join(folder, "1.json")
      yield* Effect.promise(() => fs.writeFile(broken, "{ not json"))
      expect(yield* TuiDrafts.take(folder, { [TuiDrafts.variable]: broken })).toEqual([])
      expect(yield* Effect.promise(() => fs.exists(broken))).toBe(false)
      // A file that is JSON but not drafts is dropped whole, not half-read.
      yield* Effect.promise(() => fs.writeFile(broken, JSON.stringify({ drafts: [{ prompt: { text: 1 } }] })))
      expect(yield* TuiDrafts.take(folder, { [TuiDrafts.variable]: broken })).toEqual([])
    }),
  )
})
