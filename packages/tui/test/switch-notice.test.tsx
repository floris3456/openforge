import { expect, test } from "bun:test"
import type { OpenCodeEvent, UpgradeState } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"
import { shows, words } from "./fixture/wait"

// A service that can go away and come back paused, as during a release switch. `next` resolves at its next request
// for `path`.
function service() {
  const state = { down: false, pause: "running" as "running" | "paused" }
  const waiting = new Set<{ readonly path: string; readonly heard: () => void }>()
  return {
    state,
    next: (path: string) =>
      new Promise<void>((resolve) => {
        const entry = {
          path,
          heard: () => {
            waiting.delete(entry)
            resolve()
          },
        }
        waiting.add(entry)
      }),
    fetch: (url: URL) => {
      for (const entry of Array.from(waiting)) if (entry.path === url.pathname) entry.heard()
      if (url.pathname === "/api/event" && state.down) return new Response(null, { status: 503 })
      if (url.pathname === "/api/experimental/service/status")
        return json({
          data: { state: state.pause, startedPaused: state.pause === "paused", waiting: [], rested: [], active: [] },
        })
      // The update dialog names the chats a switch waits for; the notice counts them only.
      if (url.pathname === "/api/session/ses_busy")
        return json({
          data: {
            id: "ses_busy",
            projectID: "proj_test",
            title: "Fix the tests",
            location: { directory: "/elsewhere" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
    },
  }
}

const event = (type: string, data: unknown) => ({ id: `evt_${type}`, created: Date.now(), type, data }) as OpenCodeEvent
const work = [{ sessionID: "ses_busy", kind: "tool" as const, name: "webfetch" }]
const overlay = (frame: string) => frame.includes("Connection lost") || frame.includes("Restarting service")

test("a switch shows a short notice instead of the full-screen reconnect, until the new release resumes", async () => {
  const fake = service()
  await using setup = await createAppFixture({ fetch: fake.fetch })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))

  setup.events.emit(event("service.pausing", { deadline: Date.now() + 120_000, waiting: work }))
  await shows(setup, (frame) => frame.includes("Updating to a new openforge release · waiting for 1 chat"))
  // The notice counts the chats; it never names one.
  expect(words(setup)).not.toContain("Fix the tests")
  setup.events.emit(event("service.paused", { rested: ["ses_busy"] }))
  await shows(setup, (frame) => frame.includes("Updating to a new openforge release") && !frame.includes("waiting for"))

  // The old service stops. The overlay would show 1 s into reconnecting, which is before the stream, 1 s later, tries
  // again.
  fake.state.down = true
  fake.state.pause = "paused"
  const retried = fake.next("/api/event")
  setup.events.disconnect()
  await retried
  await setup.renderOnce()
  const during = words(setup)
  expect(during).toContain("Updating to a new openforge release")
  expect(overlay(during)).toBe(false)

  // The new release comes up paused, then resumes. The stream reaches it and the screen reads its pause.
  const read = fake.next("/api/experimental/service/status")
  fake.state.down = false
  await read
  await setup.renderOnce()
  expect(words(setup)).toContain("Updating to a new openforge release")
  fake.state.pause = "running"
  setup.events.emit(event("service.resumed", {}))
  await shows(setup, (frame) => !frame.includes("Updating to"))
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
  expect(setup.captureCharFrame()).not.toContain("Updating to")
}, 15_000)

test("the upgrade dialog shows the switch's steps and names the chats, so the notice stays away while it is open", async () => {
  const listeners = new Set<(state: UpgradeState) => void>()
  const switched = Promise.withResolvers<void>()
  const updater = {
    subscribe: (notify: (state: UpgradeState) => void) => {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    upgrade: async () => {
      listeners.forEach((notify) => notify({ type: "switching", version: "0.1.1", waiting: work }))
      await switched.promise
      return { type: "current" as const, version: "0.1.1" }
    },
  }
  await using setup = await createAppFixture({ updater, fetch: service().fetch })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("/update")
  await setup.waitForFrame((frame) => frame.includes("Upgrade openforge"))
  setup.mockInput.pressKey("RETURN")
  const message = 'Switching to openforge 0.1.1; waiting for webfetch in "Fix the tests"…'
  await shows(setup, (frame) => frame.includes(message))
  expect(words(setup)).not.toContain("Updating to openforge")

  // Closed, the dialog leaves the notice to count what the switch waits for.
  setup.mockInput.pressEscape()
  await shows(
    setup,
    (frame) =>
      !frame.includes("Upgrade openforge") && frame.includes("Updating to openforge 0.1.1 · waiting for 1 chat"),
  )
  switched.resolve()
}, 15_000)

test("the screen that runs the switch names the release it switches to", async () => {
  const listeners = new Set<(state: UpgradeState) => void>()
  const updater = {
    subscribe: (notify: (state: UpgradeState) => void) => {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    upgrade: async () => ({ type: "current" as const, version: "0.1.0" }),
  }
  await using setup = await createAppFixture({ updater, fetch: service().fetch })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  listeners.forEach((notify) => notify({ type: "switching", version: "0.1.1" }))
  await shows(setup, (frame) => frame.includes("Updating to openforge 0.1.1"))
  setup.events.emit(event("service.pausing", { deadline: Date.now() + 120_000, waiting: work }))
  await shows(setup, (frame) => frame.includes("Updating to openforge 0.1.1 · waiting for 1 chat"))
  listeners.forEach((notify) =>
    notify({ type: "waiting", version: "0.1.1", expired: { limit: 120_000, waiting: work } }),
  )
  setup.events.emit(event("service.pause.expired", { waiting: work }))
  await shows(setup, (frame) => !frame.includes("Updating to") && frame.includes("openforge 0.1.1 is installed"))
}, 15_000)

// Three chats, one of them with a tool and a step at once, and a compaction outside every chat.
const several = [
  { sessionID: "ses_a", kind: "tool" as const, name: "webfetch" },
  { sessionID: "ses_a", kind: "step" as const, name: "reply" },
  { sessionID: "ses_b", kind: "step" as const, name: "reply" },
  { sessionID: "ses_c", kind: "model" as const, name: "slow" },
  { kind: "step" as const, name: "compaction" },
]

const rows = (setup: { captureCharFrame: () => string }) => setup.captureCharFrame().split("\n")
const noticeRow = (setup: { captureCharFrame: () => string }) =>
  rows(setup).findIndex((line) => line.includes("Updating to"))

test.each([80, 200])(
  "the notice takes one row at the bottom, on the home screen too, at %i columns",
  async (width) => {
    const fake = service()
    await using setup = await createAppFixture({ width, height: 24, fetch: fake.fetch })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Ask anything"))
    setup.events.emit(event("service.pausing", { deadline: Date.now() + 120_000, waiting: several }))
    await shows(setup, (frame) => frame.includes("waiting for 3 chats and 1 command"))

    const lines = rows(setup)
    const found = noticeRow(setup)
    // One row, at the screen's bottom: at most a devtools bar below it, nothing above it has to move.
    expect(found).toBeGreaterThanOrEqual(lines.length - 2)
    expect(lines.filter((line) => line.includes("Updating to"))).toHaveLength(1)
    expect(lines.filter((line) => line.includes("3 chats and 1 command"))).toHaveLength(1)
    // It counts; it never names a chat.
    expect(words(setup)).not.toContain("Fix the tests")
  },
  15_000,
)

test("a narrow row drops the count before it wraps", async () => {
  const fake = service()
  await using setup = await createAppFixture({ width: 40, height: 20, fetch: fake.fetch })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Ask anything"))
  setup.events.emit(event("service.pausing", { deadline: Date.now() + 120_000, waiting: several }))
  await shows(setup, (frame) => frame.includes("Updating to a new openforge release"))
  expect(words(setup)).not.toContain("waiting for")
  expect(rows(setup).filter((line) => line.includes("Updating to"))).toHaveLength(1)
}, 15_000)
