import { expect, test } from "bun:test"
import { stashDrafts, stashedDrafts, takeDraft } from "../src/component/prompt/draft-stash"
import type { UpgradeState } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { until } from "./fixture/wait"

// A source whose updater reports a finished switch whenever the test says so, and records restarts.
function source() {
  const listeners = new Set<(state: UpgradeState) => void>()
  const relaunches: Array<string | undefined> = []
  const relaunched: number[] = []
  return {
    relaunches,
    /** When each restart was asked for, by `performance.now()`. */
    relaunched,
    switched: (version: string) => listeners.forEach((notify) => notify({ type: "switched", version })),
    updater: {
      subscribe: (notify: (state: UpgradeState) => void) => {
        listeners.add(notify)
        return () => listeners.delete(notify)
      },
      upgrade: async () => ({ type: "current" as const, version: "0.0.1" }),
      relaunch: (sessionID?: string) => {
        relaunches.push(sessionID)
        relaunched.push(performance.now())
      },
    },
  }
}

test("restarts on the new release at once when nothing is typed", async () => {
  const fake = source()
  await using setup = await createAppFixture({ updater: fake.updater })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  fake.switched("0.0.1")
  await until(() => fake.relaunches.length > 0)
  expect(fake.relaunches).toEqual([undefined])
  await until(() => setup.renderer.isDestroyed)
})

test("restarts with a half-typed prompt, which the restarted screen puts back in the composer", async () => {
  // The stash lives as long as the process: drop what other tests in it left there.
  for (const draft of stashedDrafts()) takeDraft(draft.sessionID)
  try {
    const fake = source()
    {
      await using setup = await createAppFixture({ updater: fake.updater })
      await setup.ready
      await setup.waitForFrame((frame) => frame.includes("commands"))
      await setup.mockInput.typeText("half a thought")
      await setup.waitForFrame((frame) => frame.includes("half a thought"))
      fake.switched("0.0.1")
      await until(() => fake.relaunches.length > 0)
      await until(() => setup.renderer.isDestroyed)
    }
    // What the CLI writes for the restarted process and reads back there.
    const carried = JSON.parse(JSON.stringify(stashedDrafts()))
    expect(carried).toMatchObject([{ prompt: { text: "half a thought" } }])
    takeDraft(undefined)
    stashDrafts(carried)

    await using restarted = await createAppFixture({ updater: source().updater })
    await restarted.ready
    await restarted.waitForFrame((frame) => frame.includes("commands") && frame.includes("half a thought"))
  } finally {
    takeDraft(undefined)
  }
})

test("waits with the restart while keys are coming in", async () => {
  const fake = source()
  await using setup = await createAppFixture({ updater: fake.updater })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  fake.switched("0.0.1")
  // The restart runs 300 ms after the last key. Each key goes once the screen shows the one before, so the keys take
  // several frames, and a restart that ignored them would come sooner after the last one.
  let last = 0
  let typed = ""
  for (const key of "typing on") {
    typed += key
    last = performance.now()
    await setup.mockInput.typeText(key)
    await setup.waitForFrame((frame) => frame.includes(typed))
  }
  await until(() => fake.relaunches.length > 0)
  expect(fake.relaunches).toEqual([undefined])
  expect(fake.relaunched[0] - last).toBeGreaterThanOrEqual(295)
  takeDraft(undefined)
})

test("the screen that ran /update restarts too, with its dialog still open", async () => {
  const fake = source()
  const updater = {
    ...fake.updater,
    upgrade: async () => {
      fake.switched("0.0.2")
      return { type: "switched" as const, from: "0.0.1", to: "0.0.2" }
    },
  }
  await using setup = await createAppFixture({ updater })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("/update")
  await setup.waitForFrame((frame) => frame.includes("Upgrade openforge"))
  setup.mockInput.pressKey("RETURN")
  await setup.waitForFrame((frame) => frame.includes("Switched to openforge 0.0.2; restarting"))
  await until(() => fake.relaunches.length > 0)
  expect(fake.relaunches).toEqual([undefined])
  await until(() => setup.renderer.isDestroyed)
})

test("restarts back on the open chat", async () => {
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const session = {
    id: "ses_upgrade",
    title: "Chat that survives an upgrade",
    projectID: "project",
    location: { directory },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const fake = source()
  await using setup = await createAppFixture({
    updater: fake.updater,
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Chat that survives an upgrade"))
  fake.switched("0.0.1")
  await until(() => fake.relaunches.length > 0)
  expect(fake.relaunches).toEqual([session.id])
})
