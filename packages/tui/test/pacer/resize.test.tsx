import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import type { Config } from "../../src/config"
import { createAppFixture } from "../fixture/app"
import { waitForHighlightedFrame } from "../fixture/frame"
import { recordFrames, type RecordedFrame } from "../fixture/frames"
import { json } from "../fixture/tui-client"
import { until } from "../fixture/wait"
import { CHAT, chat, accounts, NOW, pacerFake, request, sessionInfo, status } from "./fixture"

// The fixture's chats and accounts are as of NOW, and the whole app's countdowns run on the wall clock (WallClock):
// it stands at NOW, or the chat's 5 minutes of warmth would have run out since 2026-11-06 14:07.
beforeEach(() => setSystemTime(NOW))
afterEach(() => setSystemTime())

// The first frame drawn at a new size has the new width's layout (backlog cpp-step-1-tui, item 13). The session's
// width came from its pane's onSizeChange, which OpenTUI calls while it draws that frame, and text and <Show> branches
// changed then are drawn only in the next frame: the first one had the old width's column header and hints, and where
// the tab bar changed form, only "esc" over the list (round-3 fix3-main frames 427 and 431).

const HEIGHT = 40

const transcript: SessionMessageInfo[] = [
  { type: "user", id: "msg_u1", text: "First question", time: { created: NOW - 20_000 } },
  {
    type: "assistant",
    id: "msg_a1",
    agent: "build",
    model: { providerID: "cliproxypacer", id: "claude-opus-4-5" },
    time: { created: NOW - 10_000, completed: NOW - 5_000 },
    finish: "stop",
    proxyRequestID: "req_0",
    tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: "text", text: "Latest reply" }],
  } as unknown as SessionMessageInfo,
]

async function app(input: { width: number; config: Config.Info }) {
  const fake = pacerFake()
  fake.status = status("on")
  fake.chats[CHAT] = chat()
  fake.accounts = accounts()
  fake.requests[CHAT] = Array.from({ length: 3 }, (_, index) => request(index, { at: NOW - 10_000 - index * 1000 }))
  const setup = await createAppFixture({
    width: input.width,
    height: HEIGHT,
    config: { animations: false, ...input.config },
    args: { sessionID: CHAT },
    fetch: async (url, request) => {
      const pacer = await fake.handle(url, request)
      if (pacer) return pacer
      if (url.pathname === `/api/session/${CHAT}`)
        return json({ data: sessionInfo(CHAT, "cliproxypacer", undefined, 1.23) })
      if (url.pathname === `/api/session/${CHAT}/message`) return json({ data: transcript.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${CHAT}/inbox` || url.pathname === `/api/session/${CHAT}/permission`)
        return json({ data: [] })
    },
  })
  await setup.ready
  return setup
}

const FULL_BAR = /^Subagents {2}Shell {2}Terminals {2}Requests +esc$/
const ACTIVE_BAR = /^Requests ←\/→ +esc$/
const ALL_HINTS = "go to enter  what changed ctrl+enter  show misses ctrl+a  help ?  tabs ←/→"
/** The Requests tab at each width of the session's pane: its tab bar, the list's column header and its hints. */
const LAYOUTS = {
  // 38 and 60 columns: the sidebar, when shown in a window this narrow, lies over the session.
  38: { bar: ACTIVE_BAR, header: "time      kind  ve…     cost", hints: "go to enter" },
  60: {
    bar: FULL_BAR,
    header: "time      kind  read/write   verdict          cost",
    hints: "go to enter  what changed ctrl+enter",
  },
  // 88 and 118: 130 and 160 columns less the docked sidebar's 42; 100: no sidebar docked at 100 columns; 116: 200
  // columns less the vertical tabs' 42 and the sidebar's 42.
  88: {
    bar: FULL_BAR,
    header: "time      kind  model            account  read/write   verdict            cost",
    hints: ALL_HINTS,
  },
  100: {
    bar: FULL_BAR,
    header: "time      kind  model            account  read/write   verdict                        cost",
    hints: ALL_HINTS,
  },
  116: {
    bar: FULL_BAR,
    header:
      "time      kind        model               account       read/write   verdict                          cost",
    hints: ALL_HINTS,
  },
  118: {
    bar: FULL_BAR,
    header:
      "time      kind        model               account       read/write    verdict                           cost",
    hints: ALL_HINTS,
  },
} as const

type Case = { name: string; config: Config.Info; sizes: readonly (readonly [number, keyof typeof LAYOUTS])[] }
// Each case resizes from its first width to the others in turn, each [terminal width, the session pane's width]:
// across the width where the tab bar shows only the active tab (both ways), and where the sidebar docks.
const cases: Case[] = [
  {
    name: "no sidebar",
    config: { session: { sidebar: "hide" } },
    sizes: [
      [100, 100],
      [38, 38],
      [100, 100],
      [60, 60],
      [38, 38],
      [60, 60],
    ],
  },
  {
    name: "the sidebar beside the session past 120 columns",
    config: { session: { sidebar: "auto" } },
    sizes: [
      [160, 118],
      [100, 100],
      [160, 118],
      [38, 38],
      [130, 88],
      [60, 60],
      [160, 118],
    ],
  },
  {
    name: "vertical tabs, and the sidebar past 120 columns beside them",
    config: { session: { sidebar: "auto" }, tabs: { mode: "on", layout: "vertical" } },
    sizes: [
      [200, 116],
      [100, 100],
      [200, 116],
      [38, 38],
    ],
  },
]

/** The frame's text with the toolbar's countdown left out, which ticks on its own, and no blanks at line ends. */
const settled = (text: string) =>
  text
    .replace(/warm +\d+(?::\d\d){1,2}/g, "warm")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
const widthOf = (frame: RecordedFrame) => frame.text.split("\n")[0]!.length

describe.each(cases)("the first frame after a resize, $name", (input) => {
  test("has the new width's tab bar, column header and hints", async () => {
    const [start, ...resizes] = input.sizes
    await using setup = await app({ width: start![0], config: input.config })
    await waitForHighlightedFrame(setup, (frame) => /warm \d+:\d\d/.test(frame) && frame.includes("Latest reply"), {
      maxPasses: 200,
    })
    // A click on the toolbar's cache item opens the composer at the Requests tab.
    const lines = setup.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => /warm \d+:\d\d/.test(line))
    await setup.mockMouse.click(lines[row]!.search(/warm \d/) + 2, row)
    await setup.waitForFrame((frame) => frame.includes("Requests") && frame.includes("go to"), { maxPasses: 100 })

    using recorder = recordFrames(setup)
    for (const [width, pane] of resizes) {
      const mark = recorder.mark()
      setup.resize(width, HEIGHT)
      await until(() => mark().some((frame) => widthOf(frame) === width), 5_000, `a frame at ${width} columns`)
      const first = mark().find((frame) => widthOf(frame) === width)!
      // The session pane's columns, as laid out: the composer's lines without the vertical tabs or the sidebar.
      const node = setup.renderer.root.findDescendantById("session-pane")!
      expect(node.width).toBe(pane)
      const composer = first.text
        .split("\n")
        .map((line) => line.slice(node.x, node.x + node.width))
        .filter((line) => line.trimStart().startsWith("┃"))
        .map((line) => line.trimStart().slice(1).trim())
      const layout = LAYOUTS[pane]
      const at = `${width} columns, frame ${first.id}:\n${first.text}`
      expect(
        composer.find((line) => line.endsWith("esc")),
        at,
      ).toMatch(layout.bar)
      expect(
        composer.find((line) => line.startsWith("time")),
        at,
      ).toBe(layout.header)
      expect(
        composer.find((line) => line.startsWith("go to")),
        at,
      ).toBe(layout.hints)
      // And it is the whole of what the next frame draws.
      await setup.renderOnce()
      expect(settled(first.text), at).toBe(settled(setup.captureCharFrame()))
    }
    expect(recorder.missed).toBe(0)
  })
})
