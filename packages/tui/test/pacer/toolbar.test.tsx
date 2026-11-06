/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { recordFrames } from "../fixture/frames"
import { until } from "../fixture/wait"
import { CHAT, chat, colorOf, NOW, OTHER, pacerFake, renderPacer, status, step, Toolbar } from "./fixture"

// Section 4 of spec cliproxypacer-step-1: the toolbar's cache item, under the prompt, after the context and cost.

async function toolbar(input: {
  state?: Parameters<typeof status>[0]
  view?: ReturnType<typeof chat> | null
  width?: number
  providerID?: string
  usage?: boolean
}) {
  const fake = pacerFake()
  fake.status = status(input.state ?? "on")
  if (input.view !== null) fake.chats[CHAT] = input.view ?? chat()
  const setup = await renderPacer({
    fake,
    width: input.width ?? 100,
    height: 3,
    sessions: {
      [CHAT]: {
        providerID: input.providerID ?? "cliproxypacer",
        cost: input.usage ? 1.23 : 0,
        messages: input.usage ? [step("msg_1", { created: NOW - 60_000, tokens: 1234 })] : [],
      },
    },
    content: () => <Toolbar sessionID={CHAT} />,
  })
  return { ...setup, fake }
}

const line = (setup: { app: { captureCharFrame: () => string } }) => setup.app.captureCharFrame().split("\n")[0]!

describe("the cache item", () => {
  test("pings run: warm 23:41", async () => {
    await using setup = await toolbar({})
    await setup.app.waitForFrame((frame) => frame.includes("warm 23:41"))
    expect(line(setup)).toMatch(/~\/project +warm 23:41 {2}ctrl\+p commands/)
    expect(colorOf(setup.app, "warm 23:41")).toEqual(setup.theme.text.muted.toInts())
  })

  test("each row of the table", async () => {
    const rows: [ReturnType<typeof chat>, string, "muted" | "warning"][] = [
      [
        chat({
          switches: { warming: false, compactBeforeCold: false },
          pings: { active: false, left: 0, sent: 0, failed: false },
          coldAt: NOW + 192_000,
        }),
        "warming off · warm 3:12",
        "muted",
      ],
      [chat({ warm: false }), "cache cold", "warning"],
      [
        chat({
          pings: { active: false, left: 0, sent: 3, failed: true, stopped: "unauthorized" },
          coldAt: NOW + 130_000,
        }),
        "keep-alive stopped · warm 2:10",
        "warning",
      ],
      [
        chat({
          switches: { warming: true, compactBeforeCold: true },
          compactAt: new Date(2026, 10, 6, 14, 32).getTime(),
          compactReason: "before-cold",
        }),
        "compacts at 14:32",
        "muted",
      ],
      [chat({ forceUse: { account: "max-1", when: "now" } }), "account used up · next step moves to max-1", "warning"],
    ]
    for (const [view, text, tone] of rows) {
      await using setup = await toolbar({ view, width: 120 })
      await setup.app.waitForFrame((frame) => frame.includes(text))
      const color = tone === "warning" ? setup.theme.text.feedback.warning.base : setup.theme.text.muted
      expect(colorOf(setup.app, text)).toEqual(color.toInts())
    }
  })

  test("CPP unreachable: the last text, greyed, as of when CPP last answered, without a ticking clock", async () => {
    await using setup = await toolbar({})
    await setup.app.waitForFrame((frame) => frame.includes("warm 23:41"))
    expect(setup.pacer.ticking()).toBe(true)
    setup.clock.advance(65_000)
    await setup.app.waitForFrame((frame) => frame.includes("warm 22:36"))
    // CPP last answered at 14:02:00, the moment the countdown said 23:41.
    setup.emit({ type: "pacer.status", data: { status: status("unreachable", { asOf: NOW }) } })
    await setup.frame((frame) => frame.includes("warm 23:41 · as of 14:02"))
    expect(colorOf(setup.app, "warm 23:41 · as of 14:02")).toEqual(setup.theme.text.faint.toInts())
    expect(setup.pacer.ticking()).toBe(false)
    expect(setup.clock.pendingTimerCount).toBe(0)
  })

  test("no pacer, a chat not on CPP, and no CPP set up: nothing", async () => {
    for (const input of [{ state: "no-pacer" as const }, { providerID: "anthropic" }, { state: "unset" as const }]) {
      await using setup = await toolbar(input)
      await setup.app.renderOnce()
      expect(line(setup)).toMatch(/~\/project +agents {2}ctrl\+p commands/)
      expect(line(setup)).not.toContain("warm")
      expect(setup.pacer.ticking()).toBe(false)
      expect(setup.clock.pendingTimerCount).toBe(0)
      // No CPP set up: nothing is read but the status; a chat on another provider: nothing of the chat.
      if (input.state === "unset") expect(setup.fake.calls.map((call) => call.path)).toEqual(["status"])
      expect(setup.fake.calls.filter((call) => call.path.startsWith("chat"))).toEqual([])
    }
  })

  test("clicking it opens the footer at the Requests tab", async () => {
    await using setup = await toolbar({})
    await setup.app.waitForFrame((frame) => frame.includes("warm 23:41"))
    const opened: string[] = []
    const detach = setup.pacer.attach(CHAT, { open: () => opened.push(CHAT) })
    const column = line(setup).indexOf("warm 23:41")
    await setup.app.mockMouse.click(column + 2, 0)
    expect(opened).toEqual([CHAT])
    detach()
  })
})

describe("a narrow window", () => {
  // Context and cost are 1.2K · $1.23; the item is warm 23:41; the shortcut ctrl+p commands.
  test.each([
    [120, true, true, true],
    [70, true, true, false],
    [50, false, true, false],
    [20, false, false, false],
  ])("at %i columns: usage %p, the cache item %p, shortcuts %p", async (width, usage, cache, shortcuts) => {
    await using setup = await toolbar({ usage: true, width })
    await until(() => setup.pacer.view(CHAT) !== undefined)
    await setup.app.renderOnce()
    const text = line(setup)
    expect(text.includes("1.2K · $1.23")).toBe(usage)
    expect(text.includes("warm 23:41")).toBe(cache)
    expect(text.includes("ctrl+p commands")).toBe(shortcuts)
    if (usage && cache) expect(text).toContain("1.2K · $1.23 · warm 23:41")
  })
})

describe("the countdown changes only its digits", () => {
  test("over a minute boundary and over 10:00 → 9:59, on every frame drawn", async () => {
    await using setup = await toolbar({ view: chat({ coldAt: NOW + 10 * 60_000 + 2_000 }) })
    await setup.app.waitForFrame((frame) => frame.includes("warm 10:02"))
    using recorder = recordFrames(setup.app)
    for (let second = 0; second < 4; second++) {
      setup.clock.advance(1000)
      await setup.app.waitForFrame(() => recorder.frames.length > second)
    }
    const footers = recorder.frames.map((frame) => frame.text.split("\n")[0]!)
    expect(footers.map((text) => text.match(/warm +\d+:\d\d/)?.[0])).toEqual([
      "warm 10:01",
      "warm 10:00",
      "warm  9:59",
      "warm  9:58",
    ])
    // Every frame drawn is the same line but for the digits: the item keeps its width and place.
    const first = footers[0]!
    for (const text of footers) {
      expect(text).toHaveLength(first.length)
      expect([...text].every((char, index) => char === first[index] || /[\d :]/.test(char + first[index]))).toBe(true)
      expect(text.indexOf("warm")).toBe(first.indexOf("warm"))
      expect(text.indexOf("ctrl+p")).toBe(first.indexOf("ctrl+p"))
    }
    // A minute boundary keeps the width as it is.
    setup.clock.advance(58_000)
    await setup.app.waitForFrame((frame) => frame.includes("warm  9:00"))
    const mark = recorder.mark()
    setup.clock.advance(1000)
    await setup.app.waitForFrame((frame) => frame.includes("warm  8:59"))
    expect(mark().map((frame) => frame.text.split("\n")[0]!.match(/warm +\d+:\d\d/)?.[0])).toEqual(["warm  8:59"])
  })

  test("the cache goes cold when the countdown ends, and the clock stops", async () => {
    await using setup = await toolbar({ view: chat({ coldAt: NOW + 2_000 }) })
    await setup.app.waitForFrame((frame) => frame.includes("warm 0:02"))
    setup.clock.advance(2_000)
    await setup.app.waitForFrame((frame) => frame.includes("cache cold"))
    expect(setup.pacer.ticking()).toBe(false)
  })
})

test("an event for another chat costs a comparison and changes nothing", async () => {
  await using setup = await toolbar({})
  await setup.app.waitForFrame((frame) => frame.includes("warm 23:41"))
  await setup.settle()
  const calls = setup.fake.calls.length
  const before = setup.app.captureCharFrame()
  using recorder = recordFrames(setup.app)
  setup.emit({ type: "pacer.chat.updated", data: { chat: chat({ sessionID: OTHER, warm: false }) } })
  setup.emit({ type: "pacer.requests.updated", data: { sessionID: OTHER } })
  await Bun.sleep(40)
  expect(setup.fake.calls.length).toBe(calls)
  expect(recorder.frames.filter((frame) => frame.text !== before)).toEqual([])
  // The chat's own update shows at once.
  setup.emit({ type: "pacer.chat.updated", data: { chat: chat({ warm: false }) } })
  await setup.frame((frame) => frame.includes("cache cold"))
})
