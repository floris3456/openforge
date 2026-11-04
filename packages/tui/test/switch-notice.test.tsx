import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import type { UpdateState } from "../src/context/update-notification"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

// A service that can go away and come back paused, as during a release switch.
function service() {
  const state = { down: false, pause: "running" as "running" | "paused" }
  return {
    state,
    fetch: (url: URL) => {
      if (url.pathname === "/api/event" && state.down) return new Response(null, { status: 503 })
      if (url.pathname === "/api/experimental/service/status")
        return json({
          data: { state: state.pause, startedPaused: state.pause === "paused", waiting: [], rested: [], active: [] },
        })
    },
  }
}

const event = (type: string, data: unknown) => ({ id: `evt_${type}`, created: Date.now(), type, data }) as OpenCodeEvent
const work = [{ sessionID: "ses_busy", kind: "tool" as const, name: "webfetch" }]
const overlay = (frame: string) => frame.includes("Connection lost") || frame.includes("Restarting service")
// The screen's words, without the lines that wrap them or the borders around them.
const words = (frame: string) => frame.replace(/[┃│]/g, " ").replace(/\s+/g, " ")
// Waits until the screen shows a frame that matches, re-rendering on its own as the app's timers fire.
async function shows(setup: { captureCharFrame: () => string }, match: (frame: string) => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!match(words(setup.captureCharFrame()))) {
    if (Date.now() > deadline) throw new Error(`frame did not match in time:\n${setup.captureCharFrame()}`)
    await Bun.sleep(20)
  }
}

test("a switch shows what it waits for instead of the full-screen reconnect, until the new release resumes", async () => {
  const fake = service()
  await using setup = await createAppFixture({ fetch: fake.fetch })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))

  setup.events.emit(event("service.pausing", { deadline: Date.now() + 120_000, waiting: work }))
  await shows(setup, (frame) =>
    frame.includes("Switching to a new openforge release; waiting for webfetch in ses_busy…"),
  )
  setup.events.emit(event("service.paused", { rested: ["ses_busy"] }))
  await shows(setup, (frame) => frame.includes("Switching to a new openforge release…"))

  // The old service stops; the overlay would show after 1 s of reconnecting.
  fake.state.down = true
  fake.state.pause = "paused"
  setup.events.disconnect()
  await Bun.sleep(1_500)
  const during = words(setup.captureCharFrame())
  expect(during).toContain("Switching to a new openforge release…")
  expect(overlay(during)).toBe(false)

  // The new release comes up paused, then resumes.
  fake.state.down = false
  await Bun.sleep(1_000)
  expect(words(setup.captureCharFrame())).toContain("Switching to a new openforge release…")
  fake.state.pause = "running"
  setup.events.emit(event("service.resumed", {}))
  await shows(setup, (frame) => !frame.includes("Switching to"))
  expect(overlay(setup.captureCharFrame())).toBe(false)
}, 15_000)

test("without a switch, losing the service still shows the full-screen reconnect", async () => {
  const fake = service()
  await using setup = await createAppFixture({ fetch: fake.fetch })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  fake.state.down = true
  setup.events.disconnect()
  await shows(setup, overlay)
  expect(setup.captureCharFrame()).not.toContain("Switching to")
}, 15_000)

test("the screen that runs the switch names the release it switches to", async () => {
  const listeners = new Set<(state: UpdateState) => void>()
  const updater = {
    remote: false,
    subscribe: (notify: (state: UpdateState) => void) => {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    upgrade: async () => ({ type: "current" as const, version: "0.1.0" }),
  }
  await using setup = await createAppFixture({ updater })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  listeners.forEach((notify) => notify({ type: "switching", version: "0.1.1" }))
  await shows(setup, (frame) => frame.includes("Switching to openforge 0.1.1…"))
  setup.events.emit(event("service.pausing", { deadline: Date.now() + 120_000, waiting: work }))
  await shows(setup, (frame) => frame.includes("Switching to openforge 0.1.1; waiting for webfetch in ses_busy…"))
  listeners.forEach((notify) => notify({ type: "waiting", version: "0.1.1", waiting: work }))
  setup.events.emit(event("service.pause.expired", { waiting: work }))
  await shows(setup, (frame) => !frame.includes("Switching to") && frame.includes("openforge 0.1.1 is installed"))
}, 15_000)
