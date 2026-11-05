import { expect, test } from "bun:test"
import { App } from "@opencode/core/app"
import pkg from "../package.json"

test("formats app metadata as a user agent", () => {
  expect(App.useragent(App.make({ name: "sdk", version: "1.2.3", channel: "beta" }))).toBe(
    `opencode/beta/${App.UPSTREAM_VERSION}/openforge`,
  )
})

// OpenCode Zen gives its free tier only to OpenCode 1.18.0 or newer, read from the user agent; openforge's own 0.0.x
// would be refused.
test("the user agent carries the upstream release openforge is built on, not openforge's version", () => {
  expect(App.UPSTREAM_VERSION).toBe(pkg.version)
  expect(App.useragent(App.make({ name: "cli", version: "0.0.4", channel: "latest" }))).not.toContain("0.0.4")
})
