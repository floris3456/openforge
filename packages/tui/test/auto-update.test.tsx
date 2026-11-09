import { expect, test } from "bun:test"
import type { AutoUpdateFailure, AutoUpdateStatus } from "@opencode/client"
import { settings } from "../src/component/dialog-config"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"
import { shows, until, words } from "./fixture/wait"

// openforge's automatic updates (spec auto-update), as the TUI shows them: Settings › Updates "Automatic updates", off
// by default, read from and written to the service; and each automatic update that failed said once.

test("Updates has one row, Automatic updates: off or on, off by default", () => {
  const rows = settings.filter((setting) => setting.category === "Updates")
  expect(rows.map((setting) => setting.title)).toEqual(["Automatic updates"])
  expect(rows[0]).toMatchObject({ default: false, values: [false, true], labels: ["off", "on"], update: true })
})

async function open(status: AutoUpdateStatus) {
  const writes: unknown[] = []
  const setup = await createAppFixture({
    width: 120,
    height: 40,
    config: { animations: false, keybinds: { "opencode.settings": "f6" } },
    fetch: async (url, request) => {
      if (url.pathname !== "/api/experimental/update") return undefined
      if (request.method === "GET") return json({ data: status })
      const body = (await request.json()) as { enabled: boolean }
      writes.push(body)
      return json({ data: { ...status, enabled: body.enabled } })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("Settings"))
  await setup.mockInput.typeText("Automatic updates")
  return { setup, writes }
}

test("the row shows the service's value and writes the service's setting, not cli.json", async () => {
  const { setup, writes } = await open({ enabled: false })
  await using _ = setup
  await setup.waitForFrame((frame) => /Automatic updates\s+off/.test(frame))
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => /Automatic updates\s+on/.test(frame))
  expect(writes).toEqual([{ enabled: true }])
  expect(setup.config()).not.toHaveProperty("update")
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => /Automatic updates\s+off/.test(frame))
  expect(writes).toEqual([{ enabled: true }, { enabled: false }])
})

test("where the service can't update, the row says so and why, and changes nothing", async () => {
  const why = "This openforge runs from a source checkout. Install a release to upgrade it."
  const { setup, writes } = await open({ enabled: false, unavailable: why })
  await using _ = setup
  await setup.waitForFrame((frame) => /Automatic updates\s+unavailable/.test(frame))
  setup.mockInput.pressArrow("right")
  await shows(setup, (frame) => frame.includes("runs from a source checkout"))
  expect(writes).toEqual([])
})

test("an automatic update that failed while attached is said once, whether read or told", async () => {
  const failure = (version: string): AutoUpdateFailure => ({
    version,
    message: `the service of openforge ${version} exited (code 1)`,
    // After this TUI attached.
    at: Date.now() + 60_000,
  })
  const first = failure("0.0.2")
  await using setup = await createAppFixture({
    width: 120,
    height: 40,
    fetch: (url) =>
      url.pathname === "/api/experimental/update" ? json({ data: { enabled: true, failure: first } }) : undefined,
  })
  await setup.ready
  // Read once the event stream connected.
  await shows(setup, (frame) => frame.includes("Automatic update to v0.0.2 failed: the service of"))
  const line = setup.captureCharFrame().split("\n")
  const row = line.findIndex((text) => text.includes("Automatic update to v0.0.2"))
  await setup.mockMouse.click(line[row].indexOf("Automatic update"), row)
  await shows(setup, (frame) => !frame.includes("Automatic update to v0.0.2"))

  // The same failure told again is not said again.
  setup.events.emit({ id: "evt_failed_1", created: 1, type: "installation.update-failed", data: { failure: first } })
  await Bun.sleep(300)
  expect(words(setup)).not.toContain("v0.0.2")
  const second = failure("0.0.3")
  setup.events.emit({ id: "evt_failed_2", created: 2, type: "installation.update-failed", data: { failure: second } })
  await shows(setup, (frame) => frame.includes("Automatic update to v0.0.3 failed"))
  expect(words(setup)).not.toContain("v0.0.2")
})

test("a failure from before this TUI attached is not said", async () => {
  let read = false
  await using setup = await createAppFixture({
    fetch: (url) => {
      if (url.pathname !== "/api/experimental/update") return undefined
      read = true
      return json({ data: { enabled: true, failure: { version: "0.0.2", message: "old", at: Date.now() - 60_000 } } })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await until(() => read)
  await Bun.sleep(300)
  expect(words(setup)).not.toContain("Automatic update")
  setup.events.emit({
    id: "evt_failed",
    created: 1,
    type: "installation.update-failed",
    data: { failure: { version: "0.0.4", message: "new", at: Date.now() + 60_000 } },
  })
  await shows(setup, (frame) => frame.includes("Automatic update to v0.0.4 failed: new"))
})
