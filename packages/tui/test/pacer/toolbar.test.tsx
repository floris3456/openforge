/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { recordFrames } from "../fixture/frames"
import { until } from "../fixture/wait"
import { CHAT, chat, colorOf, NOW, OTHER, pacerFake, renderPacer, status, step, styleOf, Toolbar } from "./fixture"

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
  test("counts down on the wall clock with the store's own clock, as in the app", async () => {
    // CPP's times are Unix ms; OpenTUI's SystemClock counts from the start of the process.
    const fake = pacerFake()
    fake.status = status("on")
    fake.chats[CHAT] = chat({ coldAt: Date.now() + 23 * 60_000 + 41_000 })
    await using setup = await renderPacer({
      fake,
      width: 100,
      height: 3,
      clock: "default",
      content: () => <Toolbar sessionID={CHAT} />,
    })
    await setup.app.waitForFrame((frame) => /warm \d/.test(frame))
    expect(line(setup)).toMatch(/warm 23:4[12] /)
  })

  test("on the default model, it follows the chat's last answer: shown after one through CPP, not after another's", async () => {
    for (const [providerID, shown] of [
      ["cliproxypacer", true],
      ["openai", false],
    ] as const) {
      const fake = pacerFake()
      fake.status = status("on")
      fake.chats[CHAT] = chat()
      await using setup = await renderPacer({
        fake,
        width: 100,
        height: 3,
        sessions: {
          [CHAT]: {
            providerID,
            unselected: true,
            messages: [
              step("msg_cpp", { created: NOW - 120_000 }),
              step("msg_last", { created: NOW - 60_000, providerID }),
            ],
          },
        },
        content: () => <Toolbar sessionID={CHAT} />,
      })
      if (shown) await setup.app.waitForFrame((frame) => frame.includes("warm 23:41"))
      else {
        // Its first answer went through CPP: its view is read for the Requests tab, and the item still draws nothing.
        await until(() => fake.calls.some((call) => call.path === `chat/${CHAT}`), 5_000)
        await setup.settle()
        expect(line(setup)).not.toContain("warm")
      }
    }
  })

  test("asks for the shown chat's view at each of its step ends, no other's; the new view replaces the held one in one frame, a slow old answer never brings it back", async () => {
    const fake = pacerFake({ delay: 200 })
    fake.status = status("on")
    fake.chats[CHAT] = chat()
    fake.chats[OTHER] = chat({ sessionID: OTHER })
    await using setup = await renderPacer({
      fake,
      width: 100,
      height: 3,
      sessions: {
        [CHAT]: { providerID: "cliproxypacer", messages: [step("msg_chat", { created: NOW - 60_000 })] },
        [OTHER]: { providerID: "cliproxypacer", messages: [step("msg_other", { created: NOW - 60_000 })] },
      },
      content: () => <Toolbar sessionID={CHAT} />,
    })
    await setup.frame((frame) => frame.includes("warm 23:41"))
    await setup.settle()
    const asks = (id: string) => fake.calls.filter((call) => call.method === "GET" && call.path === `chat/${id}`).length
    const shown = asks(CHAT)
    using recorder = recordFrames(setup.app)
    for (let round = 1; round <= 3; round++) {
      for (const sessionID of [CHAT, OTHER])
        setup.emit({
          type: "session.step.streamed",
          data: { sessionID, assistantMessageID: `msg_${sessionID}_${round}` },
        })
      await until(() => asks(CHAT) === shown + round, 5_000)
    }
    // The service answers the view it holds, slowly here, and its read beside it comes as an event first.
    setup.emit({ type: "pacer.chat.updated", data: { chat: chat({ coldAt: NOW + 40 * 60_000, asOf: NOW + 1_000 }) } })
    await setup.frame((frame) => frame.includes("warm 40:00"))
    await setup.settle()
    await Bun.sleep(50)
    await setup.app.renderOnce()
    expect(line(setup)).toContain("warm 40:00")
    expect(asks(CHAT)).toBe(shown + 3)
    expect(asks(OTHER)).toBe(0)
    // Every frame has the item: the held view until the new one, then the new one only.
    expect(recorder.missed).toBe(0)
    const lines = recorder.frames.map((frame) => frame.text.split("\n")[0]!)
    const replaced = lines.findIndex((text) => text.includes("warm 40:00"))
    expect(replaced).toBeGreaterThanOrEqual(0)
    expect(lines.slice(0, replaced).every((text) => text.includes("warm 23:41"))).toBe(true)
    expect(lines.slice(replaced).every((text) => text.includes("warm 40:00"))).toBe(true)
  })

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
          switches: { warming: false, compactBeforeCold: false, compactColdFirst: false },
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
          switches: { warming: true, compactBeforeCold: true, compactColdFirst: false },
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

  // Spec cliproxypacer-cold-ask, section 3.
  test("cold, with compact cold chats first on and the chat at least as large as the threshold: cache cold · compacts first", async () => {
    const switches = { warming: true, compactBeforeCold: false, compactColdFirst: true }
    for (const [view, text] of [
      [chat({ warm: false, switches, size: { tokens: 80_000, threshold: 70_000 } }), "cache cold · compacts first"],
      [chat({ warm: false, switches, size: { tokens: 12_000, threshold: 70_000 } }), "cache cold"],
    ] as const) {
      await using setup = await toolbar({ view, width: 120 })
      await setup.app.waitForFrame((frame) => frame.includes("cache cold"))
      expect(line(setup)).toMatch(new RegExp(`~/project +${text} {2}ctrl\\+p commands`))
      expect(colorOf(setup.app, text)).toEqual(setup.theme.text.feedback.warning.base.toInts())
    }
  })

  test("CPP unreachable: the last text, greyed, as of when CPP last answered, without a ticking clock", async () => {
    await using setup = await toolbar({})
    await setup.app.waitForFrame((frame) => frame.includes("warm 23:41"))
    expect(setup.pacer.ticking()).toBe(true)
    setup.clock.advance(65_000)
    await setup.app.waitForFrame((frame) => frame.includes("warm 22:36"))
    const current = styleOf(setup.app, "warm 22:36")
    expect(current).toEqual({ fg: setup.theme.text.muted.toInts(), dim: false })
    // CPP last answered at 14:02:00, the moment the countdown said 23:41.
    setup.emit({ type: "pacer.status", data: { status: status("unreachable", { asOf: NOW }) } })
    await setup.frame((frame) => frame.includes("warm 23:41 · as of 14:02"))
    // Greyed: faint and dimmed, so it looks unlike the current item also where the theme's faint text is its muted
    // text, as in the default theme.
    const greyed = styleOf(setup.app, "warm 23:41 · as of 14:02")
    expect(greyed).toEqual({ fg: setup.theme.text.faint.toInts(), dim: true })
    expect(greyed).not.toEqual(current)
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
      await until(() => recorder.frames.length > second, 5_000, `frame ${second}`)
    }
    expect(recorder.missed).toBe(0)
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
    await until(() => mark().length > 0, 5_000, "the frame of 8:59")
    expect(recorder.missed).toBe(0)
    expect(mark().map((frame) => frame.text.split("\n")[0]!.match(/warm +\d+:\d\d/)?.[0])).toEqual(["warm  8:59"])
  })

  test("over the hour: one that started above it keeps hours, 1:00:00 → 0:59:59, on every frame drawn", async () => {
    // Codex's countdown starts near two hours: it keeps h:mm:ss down to the end, so a tick never turns a colon into a
    // space (the frame checker's rule since workspace 73b2899).
    await using setup = await toolbar({ view: chat({ coldAt: NOW + 3_600_000 + 2_000 }) })
    await setup.app.waitForFrame((frame) => frame.includes("warm 1:00:02"))
    using recorder = recordFrames(setup.app)
    for (let second = 0; second < 4; second++) {
      setup.clock.advance(1000)
      await until(() => recorder.frames.length > second, 5_000, `frame ${second}`)
    }
    expect(recorder.missed).toBe(0)
    const footers = recorder.frames.map((frame) => frame.text.split("\n")[0]!)
    expect(footers.map((text) => text.match(/warm +[\d:]+/)?.[0])).toEqual([
      "warm 1:00:01",
      "warm 1:00:00",
      "warm 0:59:59",
      "warm 0:59:58",
    ])
    const first = footers[0]!
    for (const text of footers) {
      expect(text).toHaveLength(first.length)
      // Only digits change: every colon stays where it was.
      expect([...text].every((char, index) => char === first[index] || /^\d\d$/.test(char + first[index]))).toBe(true)
    }
    // Down to the last second in the same form.
    setup.clock.advance(3_596_000)
    await setup.frame((frame) => frame.includes("warm 0:00:02"))
    setup.clock.advance(1000)
    await setup.frame((frame) => frame.includes("warm 0:00:01"))
    // A countdown that starts under an hour keeps minutes and seconds.
    setup.emit({ type: "pacer.chat.updated", data: { chat: chat({ coldAt: NOW + 3_600_000 + 2_000 + 59 * 60_000 }) } })
    await setup.frame((frame) => /warm 59:\d\d  /.test(frame))
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
  expect(recorder.missed).toBe(0)
  expect(recorder.frames.filter((frame) => frame.text.trimEnd() !== before.trimEnd())).toEqual([])
  // The chat's own update shows at once.
  setup.emit({ type: "pacer.chat.updated", data: { chat: chat({ warm: false }) } })
  await setup.frame((frame) => frame.includes("cache cold"))
})
