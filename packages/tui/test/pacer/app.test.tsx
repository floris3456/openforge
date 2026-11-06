import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "../fixture/app"
import { waitForHighlightedFrame } from "../fixture/frame"
import { json } from "../fixture/tui-client"
import { CHAT, chat, accounts, NOW, pacerFake, request, sessionInfo, status } from "./fixture"

// The whole TUI with CLIProxyPacer's screens mounted where they show: the toolbar's cache item in the prompt's
// footer, the Account section where Context was, the Requests tab in the composer, and Enter moving the transcript.

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

async function app(input: { state: Parameters<typeof status>[0]; providerID: string }) {
  const fake = pacerFake()
  fake.status = status(input.state)
  fake.chats[CHAT] = chat()
  fake.accounts = accounts()
  fake.requests[CHAT] = [request(0, { id: "req_0", at: NOW - 10_000 }), request(1, { id: "req_1", at: NOW - 50_000 })]
  const transcript = messages(input.providerID)
  const setup = await createAppFixture({
    width: 160,
    height: 40,
    args: { sessionID: CHAT },
    fetch: async (url, request) => {
      const pacer = await fake.handle(url, request)
      if (pacer) return pacer
      if (url.pathname === `/api/session/${CHAT}`)
        return json({ data: sessionInfo(CHAT, input.providerID, undefined, 1.23) })
      if (url.pathname === `/api/session/${CHAT}/message`) return json({ data: transcript.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${CHAT}/inbox` || url.pathname === `/api/session/${CHAT}/permission`)
        return json({ data: [] })
    },
  })
  await setup.ready
  return { setup, fake }
}

test("on CPP: the cache item in the toolbar, Account where Context was, and the Requests tab moving the chat", async () => {
  const { setup, fake } = await app({ state: "on", providerID: "cliproxypacer" })
  await using _ = setup
  await waitForHighlightedFrame(setup, (frame) => frame.includes("Latest reply") && frame.includes("max-2"), {
    maxPasses: 200,
  })
  const frame = await waitForHighlightedFrame(setup, (frame) => /\$1\.23 · warm \d+:\d\d/.test(frame), {
    maxPasses: 200,
  })
  expect(frame).toContain("Account")
  expect(frame).toContain("5h  62% left")
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

test("without CPP: no cache item, no Account, no Requests tab, and no Context either", async () => {
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
  expect(frame).not.toContain("Account")
  expect(frame).not.toMatch(/^\s*Context\s*$/m)
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Subagents"), { maxPasses: 100 })
  expect(setup.captureCharFrame()).not.toContain("Requests")
  expect(fake.calls.map((call) => call.path)).toEqual(["status"])
})
