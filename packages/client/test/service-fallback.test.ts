import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { fallback } from "../src/service-probe"

const state = process.env.XDG_STATE_HOME

afterEach(() => {
  if (state === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = state
})

test("the default registration file is openforge's own, not opencode's", () => {
  process.env.XDG_STATE_HOME = path.join(path.sep, "state")
  expect(fallback()).toBe(path.join(path.sep, "state", "openforge", "service.json"))
})
