// The background service's side of automatic updates (spec auto-update): what @opencode/server/auto-update needs to
// read and write the setting, find a newer release and switch to it. The switch stops this service, so it runs in a
// detached `openforge upgrade <version> --automatic` that outlives it.

import type { AutoUpdate } from "@opencode/server/auto-update"
import { Product } from "@opencode/schema/product"
import { Global } from "@opencode/util/global"
import { Duration, Effect, FileSystem, Queue, Stream } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { spawn } from "node:child_process"
import { watch } from "node:fs"
import path from "node:path"
import { selfCommand } from "../util/process"
import { ReleaseLayout } from "./layout"
import { Updater } from "./updater"

// The global config's files, in the order Updater reads `update` from them: the last that sets it wins.
const files = ["config.json", "opencode.json", "opencode.jsonc"]

/** Test-only: milliseconds between two checks instead of 15 minutes. */
export const intervalVariable = "OPENFORGE_UPDATE_INTERVAL_MS"

export const make = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const updater = yield* Updater.Service
  const context = yield* Effect.context<FileSystem.FileSystem>()
  const layout = ReleaseLayout.at(global.data)
  return {
    policy: updater.policy(),
    write: (policy) => write(global.config, policy).pipe(Effect.provide(context)),
    unavailable: updater.unavailable(),
    newer: updater.newer(),
    switch: launch,
    failure: ReleaseLayout.bad(layout).pipe(
      Effect.map((bad) =>
        Object.entries(bad)
          .filter(([, entry]) => entry.automatic === true)
          .map(([version, entry]) => ({ version, message: entry.reason, at: Date.parse(entry.at) }))
          .toSorted((a, b) => b.at - a.at)
          .at(0),
      ),
      Effect.orElseSucceed(() => undefined),
      Effect.provide(context),
    ),
    changes: yield* fs.makeDirectory(global.config, { recursive: true }).pipe(
      Effect.as(changes(global.config)),
      Effect.orElseSucceed(() => Stream.empty),
    ),
    interval: interval(process.env[intervalVariable]),
  } satisfies AutoUpdate.Driver
})

/** Sets `update` in the last of the global config's files that exists, which wins, or in a new opencode.jsonc. */
export const write = Effect.fnUntraced(function* (directory: string, policy: "auto" | "notify") {
  const fs = yield* FileSystem.FileSystem
  const existing = yield* Effect.filter(
    files.map((name) => path.join(directory, name)),
    (file) => fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
  )
  const file = existing.at(-1) ?? path.join(directory, "opencode.jsonc")
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "{}\n"))
  const errors: ParseError[] = []
  parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return yield* Effect.fail(new Error(`${file} is not valid JSON, so "update" can't be set there`))
  const next = applyEdits(text, modify(text, ["update"], policy, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.writeFileString(file, next.endsWith("\n") ? next : `${next}\n`)
}, Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))

// Not this service's child in any way that matters: its own session, no pipes, so stopping the service leaves it
// running. Succeeds once it has ended; a failure is in upgrade.json by then.
function launch(version: string) {
  return Effect.callback<void, Error>((resume) => {
    const [command, ...args] = selfCommand()
    const env = { ...process.env }
    // Only the service the switch starts skips the switch lock.
    delete env.OPENFORGE_UPGRADE_SWITCH
    const child = spawn(command, [...args, "upgrade", version, "--automatic"], { detached: true, stdio: "ignore", env })
    child.unref()
    child.once("error", (error) => resume(Effect.fail(error)))
    child.once("exit", (code, signal) =>
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(new Error(`${Product.binary} upgrade ${version} --automatic ended with ${code ?? signal}`)),
      ),
    )
  })
}

function changes(directory: string) {
  return Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        watch(directory, (_event, name) => {
          if (name && files.includes(name.toString())) Queue.offerUnsafe(queue, undefined)
        }),
      ),
      (watcher) => Effect.sync(() => watcher.close()),
    ),
  )
}

function interval(value: string | undefined) {
  const millis = Number(value)
  return Number.isInteger(millis) && millis > 0 ? Duration.millis(millis) : undefined
}

export * as AutoUpdateDriver from "./auto-update"
