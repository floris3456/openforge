import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "../fixture/app"
import { waitForHighlightedFrame } from "../fixture/frame"
import { json } from "../fixture/tui-client"
import {
  CHAT,
  chat,
  accounts,
  miss,
  notice,
  NOW,
  OTHER,
  pacerFake,
  promptChange,
  request,
  sessionInfo,
  status,
} from "./fixture"

// The fixture's chats and accounts are as of NOW, and the whole app's countdowns run on the wall clock (WallClock):
// it stands at NOW, or the chat's 5 minutes of warmth would have run out since 2026-11-06 14:07.
beforeEach(() => setSystemTime(NOW))
afterEach(() => setSystemTime())

// The whole TUI with CLIProxyPacer's screens mounted where they show: the toolbar's cache item in the prompt's
// footer, the Usage section where Context was, the Requests tab in the composer, and Enter moving the transcript.

function messages(providerID: string): SessionMessageInfo[] {
  const step = (id: string, created: number, text: string, proxyRequestID: string) =>
    ({
      type: "assistant",
      id,
      agent: "build",
      model: { providerID, id: "claude-opus-4-5" },
      time: { created, completed: created + 5_000 },
      finish: "stop",
      proxyRequestID,
      tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "text", text }],
    }) as unknown as SessionMessageInfo
  return [
    { type: "user", id: "msg_u1", text: "First question", time: { created: NOW - 60_000 } },
    step(
      "msg_long",
      NOW - 50_000,
      `Long reply start\n\n${"A line of the long reply.\n\n".repeat(40)}Long reply end`,
      "req_1",
    ),
    { type: "user", id: "msg_u2", text: "Second question", time: { created: NOW - 20_000 } },
    step("msg_last", NOW - 10_000, "Latest reply", "req_0"),
  ]
}

/** The model a chat moves to, off CPP. */
const OTHER_MODEL = { id: "gpt-5", providerID: "openai" }

/** `shown`: the chat the TUI starts on, `CHAT` or `OTHER` (another chat on CPP, with one reply). */
async function app(input: { state: Parameters<typeof status>[0]; providerID: string; shown?: string }) {
  const fake = pacerFake()
  fake.status = status(input.state)
  fake.chats[CHAT] = chat()
  fake.chats[OTHER] = chat({ sessionID: OTHER })
  fake.accounts = accounts()
  fake.requests[CHAT] = [request(0, { id: "req_0", at: NOW - 10_000 }), request(1, { id: "req_1", at: NOW - 50_000 })]
  fake.requests[OTHER] = [request(2, { id: "req_other", sessionID: OTHER, at: NOW - 5_000 })]
  const transcript = messages(input.providerID)
  const other = [
    { type: "user", id: "msg_o1", text: "Other question", time: { created: NOW - 8_000 } },
    { ...messages(input.providerID).at(-1)!, id: "msg_o2", content: [{ type: "text", text: "Other chat's reply" }] },
  ] as SessionMessageInfo[]
  const setup = await createAppFixture({
    width: 160,
    height: 40,
    config: { animations: false, keybinds: { "model.list": "f8" } },
    args: { sessionID: input.shown ?? CHAT },
    fetch: async (url, request) => {
      const pacer = await fake.handle(url, request)
      if (pacer) return pacer
      if (url.pathname === `/api/session/${CHAT}`)
        return json({ data: sessionInfo(CHAT, input.providerID, undefined, 1.23) })
      if (url.pathname === `/api/session/${CHAT}/message`) return json({ data: transcript.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${OTHER}`) return json({ data: sessionInfo(OTHER, input.providerID) })
      if (url.pathname === `/api/session/${OTHER}/message`) return json({ data: other.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${OTHER}/inbox` || url.pathname === `/api/session/${OTHER}/permission`)
        return json({ data: [] })
      // The message a model switch adds, read back after its event.
      const switched = url.pathname.match(/^\/api\/session\/[^/]+\/message\/(msg_[^/]+)$/)?.[1]
      if (switched)
        return json({ data: { id: switched, type: "model-switched", model: OTHER_MODEL, time: { created: NOW } } })
      if (url.pathname === `/api/session/${CHAT}/inbox` || url.pathname === `/api/session/${CHAT}/permission`)
        return json({ data: [] })
    },
  })
  await setup.ready
  return { setup, fake }
}

test("on CPP: the cache item in the toolbar, Usage where Context was, and the Requests tab moving the chat", async () => {
  const { setup, fake } = await app({ state: "on", providerID: "cliproxypacer" })
  await using _ = setup
  await waitForHighlightedFrame(setup, (frame) => frame.includes("Latest reply") && frame.includes("Claude Max"), {
    maxPasses: 200,
  })
  const frame = await waitForHighlightedFrame(setup, (frame) => /\$1\.23 · warm \d+:\d\d/.test(frame), {
    maxPasses: 200,
  })
  expect(frame).toMatch(/^\s*Usage\s*$/m)
  expect(frame).toContain("Claude Max       5h                7d")
  expect(frame).toContain("████░░░  62%   1h")
  expect(frame).not.toMatch(/^\s*Context\s*$/m)
  expect(frame).not.toContain("spent")
  // A click on the cache item opens the footer at the Requests tab; Enter on the long step's row moves the
  // transcript to that step's end.
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => /warm \d+:\d\d/.test(line))
  await setup.mockMouse.click(lines[row]!.search(/warm \d/) + 2, row)
  await setup.waitForFrame((frame) => frame.includes("Requests") && frame.includes("read/write"), { maxPasses: 100 })
  expect(fake.calls.filter((call) => call.path.includes("requests")).length).toBe(2)
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  const moved = await waitForHighlightedFrame(
    setup,
    (frame) => frame.includes("Long reply end") && !frame.includes("Latest reply"),
    { maxPasses: 200 },
  )
  expect(moved).not.toContain("Long reply start")
})

test("moved to another provider: the cache item and Usage go, the Requests tab stays", async () => {
  const { setup } = await app({ state: "on", providerID: "cliproxypacer" })
  await using _ = setup
  await waitForHighlightedFrame(setup, (frame) => /\$1\.23 · warm \d+:\d\d/.test(frame) && frame.includes("Claude Max"), {
    maxPasses: 200,
  })
  setup.events.emit({
    id: "evt_model_other",
    created: NOW,
    type: "session.model.selected",
    durable: { aggregateID: CHAT, seq: 1, version: 1 },
    data: { sessionID: CHAT, model: OTHER_MODEL },
  })
  const frame = await waitForHighlightedFrame(setup, (frame) => frame.includes("$1.23") && !frame.includes("warm"), {
    maxPasses: 200,
  })
  expect(frame).not.toMatch(/^\s*Usage\s*$/m)
  expect(frame).not.toContain("Claude Max")
  // Its requests went through CPP: they still show.
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Subagents") && frame.includes("Requests"), { maxPasses: 100 })
})

test("without CPP: no cache item, no Usage, no Requests tab, and no Context either", async () => {
  const { setup, fake } = await app({ state: "unset", providerID: "anthropic" })
  await using _ = setup
  const frame = await waitForHighlightedFrame(
    setup,
    (frame) => frame.includes("Latest reply") && frame.includes("$1.23"),
    {
      maxPasses: 200,
    },
  )
  expect(frame).not.toContain("warm")
  expect(frame).not.toMatch(/^\s*Usage\s*$/m)
  expect(frame).not.toMatch(/^\s*Context\s*$/m)
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Subagents"), { maxPasses: 100 })
  expect(setup.captureCharFrame()).not.toContain("Requests")
  expect(fake.calls.map((call) => call.path)).toEqual(["status"])
})

test("the model picker has CPP's models read again each time it opens, without waiting, and never without CPP", async () => {
  for (const state of ["on", "unset"] as const) {
    const { setup, fake } = await app({ state, providerID: state === "on" ? "cliproxypacer" : "anthropic" })
    await using _ = setup
    await waitForHighlightedFrame(setup, (frame) => frame.includes("Latest reply"), { maxPasses: 200 })
    const refreshes = () => fake.calls.filter((call) => call.path === "refresh")
    expect(refreshes()).toEqual([])
    for (const opening of [1, 2]) {
      setup.mockInput.pressKey("F8")
      await setup.waitForFrame((frame) => frame.includes("Select model"), { maxPasses: 100 })
      await Bun.sleep(50)
      expect(refreshes().map((call) => call.method)).toEqual(state === "on" ? Array(opening).fill("POST") : [])
      setup.mockInput.pressEscape()
      await setup.waitForFrame((frame) => !frame.includes("Select model"), { maxPasses: 100 })
    }
  }
})

test("a cache notice shows in the corner over the chat, waits behind a dialog, and opens its request's what changed", async () => {
  const { setup, fake } = await app({ state: "on", providerID: "cliproxypacer" })
  await using _ = setup
  fake.prompts.req_1 = promptChange(miss(1, { id: "req_1" }))
  await waitForHighlightedFrame(setup, (frame) => frame.includes("Latest reply"), { maxPasses: 200 })
  setup.events.emit({
    id: "evt_notice",
    created: NOW,
    type: "pacer.notice.added",
    data: { notice: notice(1, { requestID: "req_1", at: NOW - 50_000 }) },
  } as unknown as Parameters<typeof setup.events.emit>[0])
  const frame = await setup.waitForFrame((frame) => frame.includes("Cache miss · 152K tokens not reused"), {
    maxPasses: 100,
  })
  const row = frame.split("\n").find((line) => line.includes("Cache miss"))!
  // The top-right corner: its right edge two columns from the terminal's.
  expect(row.lastIndexOf("┃")).toBe(160 - 3)
  // A dialog over it: the key opens nothing beneath.
  setup.mockInput.pressKey("F8")
  await setup.waitForFrame((frame) => frame.includes("Select model"), { maxPasses: 100 })
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("o")
  await Bun.sleep(50)
  expect(fake.calls.filter((call) => call.method === "POST" && call.path.startsWith("notices/"))).toEqual([])
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Select model"), { maxPasses: 100 })
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("o")
  const opened = await setup.waitForFrame((frame) => frame.includes("compared with req_prev"), { maxPasses: 100 })
  expect(opened).toContain("miss · prefix changed · system changed")
  expect(opened).not.toContain("Cache miss · 152K")
  expect(
    fake.calls.filter((call) => call.method === "POST" && call.path.startsWith("notices/")).map((call) => call.path),
  ).toEqual(["notices/req_1/dismiss"])
})

test("a cache notice of another chat, opened by key or by click, opens that chat's Requests tab on its request with what changed", async () => {
  // Found in the pilotty run of cpp-next (tui-1): the TUI moved to the chat, but the session route mounted for it
  // closed the composer its notice had just opened. By key the route was also mounted twice, and the copy left alive
  // off screen took the notice's request.
  for (const way of ["key", "click"] as const) {
    const { setup, fake } = await app({ state: "on", providerID: "cliproxypacer", shown: OTHER })
    await using _ = setup
    fake.prompts.req_1 = promptChange(miss(1, { id: "req_1" }))
    await waitForHighlightedFrame(setup, (frame) => frame.includes("Other chat's reply"), { maxPasses: 200 })
    setup.events.emit({
      id: `evt_notice_${way}`,
      created: NOW,
      type: "pacer.notice.added",
      data: { notice: notice(1, { requestID: "req_1", at: NOW - 50_000 }) },
    } as unknown as Parameters<typeof setup.events.emit>[0])
    const frame = await setup.waitForFrame((frame) => frame.includes("Cache miss · 152K tokens not reused"), {
      maxPasses: 100,
    })
    if (way === "key") {
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("o")
    } else {
      const lines = frame.split("\n")
      const row = lines.findIndex((line) => line.includes("Cache miss"))
      await setup.mockMouse.click(lines[row]!.indexOf("Cache miss"), row)
    }
    // The chat's transcript and, under it, its Requests tab showing what changed in the notice's request.
    const opened = await setup.waitForFrame(
      (frame) => frame.includes("Latest reply") && frame.includes("compared with req_prev"),
      { maxPasses: 200 },
    )
    expect(opened).toContain("miss · prefix changed · system changed")
    expect(opened).not.toContain("Other chat's reply")
    expect(opened).not.toContain("Cache miss · 152K")
    expect(
      fake.calls.filter((call) => call.method === "POST" && call.path.startsWith("notices/")).map((call) => call.path),
    ).toEqual(["notices/req_1/dismiss"])
    // Leaving the chat still closes the composer: back on the first chat's tab, none is open.
    setup.mockInput.pressKey("x", { ctrl: true })
    setup.mockInput.pressKey("1")
    const back = await waitForHighlightedFrame(setup, (frame) => frame.includes("Other chat's reply"), {
      maxPasses: 200,
    })
    expect(back).not.toContain("Requests")
    expect(back).not.toContain("compared with req_prev")
  }
})
