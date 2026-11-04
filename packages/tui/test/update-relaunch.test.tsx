import { expect, test } from "bun:test"
import { stashDrafts, stashedDrafts, takeDraft } from "../src/component/prompt/draft-stash"
import type { UpdateState } from "../src/context/update-notification"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

// A source whose updater reports a finished switch whenever the test says so, and records restarts.
function source() {
  const listeners = new Set<(state: UpdateState) => void>()
  const relaunches: Array<string | undefined> = []
  return {
    relaunches,
    switched: (version: string) => listeners.forEach((notify) => notify({ type: "switched", version })),
    updater: {
      remote: false,
      subscribe: (notify: (state: UpdateState) => void) => {
        listeners.add(notify)
        return () => listeners.delete(notify)
      },
      upgrade: async () => ({ type: "current" as const, version: "0.0.1" }),
      relaunch: (sessionID?: string) => void relaunches.push(sessionID),
    },
  }
}

async function until(condition: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition did not hold in time")
    await Bun.sleep(10)
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
  // The restart runs 300 ms after the last key.
  for (const key of "typing on") {
    await setup.mockInput.typeText(key)
    await Bun.sleep(100)
  }
  expect(fake.relaunches).toEqual([])
  await until(() => fake.relaunches.length > 0)
  expect(fake.relaunches).toEqual([undefined])
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
