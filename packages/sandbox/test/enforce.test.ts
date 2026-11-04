import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Sandbox } from "../src/sandbox.js"
import { scenarios, setup, type Fixture } from "./fixture/scenarios.js"

// Real processes in a real sandbox. The fixture sits in this package, not in a temp folder, because every temp folder
// is writable inside the sandbox. OPENFORGE_BINARY runs them through a compiled openforge instead of the source.
const machine = Sandbox.available()
const launch = {
  self: process.env.OPENFORGE_BINARY
    ? [process.env.OPENFORGE_BINARY]
    : [process.execPath, path.join(import.meta.dir, "fixture/sandbox-exec.ts")],
  tool: [process.execPath, path.join(import.meta.dir, "fixture/proof.ts")],
}
const state = { fixture: undefined as Fixture | undefined }

beforeAll(async () => {
  if (!machine.ok) return
  state.fixture = await setup(fs.realpathSync(fs.mkdtempSync(path.join(import.meta.dir, ".fixture-"))))
})

afterAll(() => {
  if (state.fixture) fs.rmSync(state.fixture.root, { recursive: true, force: true })
})

// These need a kernel or OS that can sandbox; the unit tests cover the rest everywhere.
describe.skipIf(!machine.ok)("sandboxed commands", () => {
  for (const scenario of scenarios.filter((item) => !item.platforms || item.platforms.includes(process.platform)))
    test(scenario.name, async () => {
      expect(await scenario.run(state.fixture!, launch)).toEqual([])
    })
})
