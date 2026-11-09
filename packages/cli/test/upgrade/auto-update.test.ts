import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { testEffect } from "../../../core/test/lib/effect"
import { tmpdirScoped } from "../../../core/test/fixture/tmpdir"
import { AutoUpdateDriver } from "../../src/upgrade/auto-update"
import { Updater } from "../../src/upgrade/updater"

// Settings › Updates "Automatic updates" is the global config's `update` (spec auto-update): on writes `auto`, off
// writes `notify`, in the file whose value counts, and the updater reads it back from there.

const it = testEffect(NodeServices.layer)

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

describe("the setting", () => {
  it.live("on and off write auto and notify into a new opencode.jsonc", () =>
    Effect.gen(function* () {
      const config = (yield* tmpdirScoped("openforge-auto-update-")).path
      yield* AutoUpdateDriver.write(config, "auto")
      const file = path.join(config, "opencode.jsonc")
      expect(Updater.decodePolicy(yield* read(file))).toBe("auto")
      yield* AutoUpdateDriver.write(config, "notify")
      expect(Updater.decodePolicy(yield* read(file))).toBe("notify")
    }),
  )

  it.live("writes into the last of the config files, keeping what else it says, over the older autoupdate", () =>
    Effect.gen(function* () {
      const config = (yield* tmpdirScoped("openforge-auto-update-")).path
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(config, "config.json"), '{ "update": "auto" }\n')
        await fs.writeFile(path.join(config, "opencode.json"), '{\n  // mine\n  "shell": "zsh",\n  "autoupdate": true\n}\n')
      })
      yield* AutoUpdateDriver.write(config, "notify")
      const text = yield* read(path.join(config, "opencode.json"))
      expect(text).toContain("// mine")
      expect(text).toContain('"shell": "zsh"')
      expect(Updater.decodePolicy(text)).toBe("notify")
      expect(yield* read(path.join(config, "config.json"))).toBe('{ "update": "auto" }\n')
      expect(yield* Effect.promise(() => fs.exists(path.join(config, "opencode.jsonc")))).toBe(false)
    }),
  )

  it.live("refuses a file that is not valid JSON and leaves it as it is", () =>
    Effect.gen(function* () {
      const config = (yield* tmpdirScoped("openforge-auto-update-")).path
      const file = path.join(config, "opencode.json")
      yield* Effect.promise(() => fs.writeFile(file, '{ "shell": '))
      const error = yield* AutoUpdateDriver.write(config, "auto").pipe(Effect.flip)
      expect(error.message).toContain("is not valid JSON")
      expect(yield* read(file)).toBe('{ "shell": ')
    }),
  )
})
