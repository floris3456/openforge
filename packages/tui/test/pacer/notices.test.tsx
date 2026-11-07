/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { PacerNotice } from "@opencode/client"
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { ManualClock } from "@opentui/core/testing"
import { readFileSync } from "fs"
import { writeFile } from "fs/promises"
import path from "path"
import { createEffect, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { settings } from "../../src/component/dialog-config"
import { Keymap } from "../../src/context/keymap"
import { useRoute } from "../../src/context/route"
import { usePacerSession } from "../../src/pacer/jump"
import { noticeSettings, PacerNotices, visibleNotices } from "../../src/pacer/notices"
import { Composer } from "../../src/routes/session/composer"
import { until } from "../fixture/wait"
import {
  CHAT,
  chat,
  colorOf,
  miss,
  notice,
  NOW,
  OTHER,
  pacerFake,
  promptChange,
  renderPacer,
  request,
  status,
  SUBAGENT,
} from "./fixture"

// Written from spec cliproxypacer-cache-notices, sections 3 and 4: the cards in the corner of every TUI, their texts
// and stacking, opening one at its request in the Requests tab, dismissing them, and this TUI's six settings.

/** The session route's part a notice opens: the transcript's place and the composer with its Requests tab. */
function Session(props: { sessionID: string }) {
  const [composer, setComposer] = createStore({ open: false, tab: undefined as string | undefined })
  usePacerSession({
    sessionID: props.sessionID,
    ready: () => true,
    open: () => setComposer({ open: true, tab: "requests" }),
    jump: () => {},
    bottom: () => {},
  })
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1}>
        <text>transcript of {props.sessionID}</text>
      </box>
      <Composer
        sessionID={props.sessionID}
        open={composer.open}
        defaultTab={composer.tab}
        onClose={() => setComposer("open", false)}
      />
    </box>
  )
}

async function cards(
  input: {
    notices?: PacerNotice[]
    state?: Parameters<typeof status>[0]
    route?: string
    width?: number
    height?: number
    config?: Parameters<typeof renderPacer>[0]["config"]
  } = {},
) {
  const fake = pacerFake()
  fake.status = status(input.state ?? "on")
  fake.notices = input.notices ?? [notice(0)]
  fake.chats[CHAT] = chat()
  fake.requests[CHAT] = Array.from({ length: 8 }, (_, index) => (index === 3 ? miss(3) : request(index)))
  fake.prompts.req_3 = promptChange(miss(3))
  let commands: readonly KeymapCommand[] = []
  function Commands() {
    const list = Keymap.useCommands()
    createEffect(() => (commands = list()))
    return null
  }
  const setup = await renderPacer({
    fake,
    width: input.width ?? 120,
    height: input.height ?? 40,
    route: input.route ?? CHAT,
    config: input.config,
    sessions: {
      [CHAT]: { providerID: "cliproxypacer" },
      [SUBAGENT]: { providerID: "cliproxypacer", parentID: CHAT },
      [OTHER]: { providerID: "cliproxypacer" },
    },
    content: () => {
      const route = useRoute()
      return (
        <box width="100%" height="100%">
          <Commands />
          <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
            {(sessionID) => <Session sessionID={sessionID} />}
          </Show>
          <PacerNotices />
        </box>
      )
    },
  })
  const palette = () =>
    commands.filter((command) => command.palette && command.group === "CLIProxyPacer").map((command) => command.title)
  return { ...setup, fake, palette }
}

type Setup = Awaited<ReturnType<typeof cards>>

const TITLE = "Cache miss · 152K tokens not reused"
const reads = (setup: Setup) => setup.fake.calls.filter((call) => call.path === "notices")
const dismissals = (setup: Setup) =>
  setup.fake.calls.filter((call) => call.method === "POST" && call.path.startsWith("notices/")).map((call) => call.path)
const count = (frame: string, text: string) => frame.split(text).length - 1

/** The colour of the card edge on the line that holds `text`. */
function edgeOf(setup: Setup, text: string) {
  const line = setup.app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes(text)))
  return line?.spans.find((span) => span.text.includes("┃"))?.fg.toInts()
}

/** Clicks the first cell of `text` on screen, or `offset` cells into it. */
async function click(setup: Setup, text: string, offset = 0) {
  const lines = setup.app.captureCharFrame().split("\n")
  const row = lines.findIndex((line) => line.includes(text))
  if (row < 0) throw new Error(`"${text}" is not on screen:\n${lines.join("\n")}`)
  await setup.app.mockMouse.click(lines[row]!.indexOf(text) + offset, row)
}

/** The time of the request row drawn bold: the one under the cursor. */
function selectedRow(setup: Setup) {
  let spans: ReturnType<Setup["app"]["captureSpans"]>
  try {
    spans = setup.app.captureSpans()
  } catch (error) {
    // Read while the renderer draws.
    if (error instanceof Error && error.message.includes("OutputBusy")) return undefined
    throw error
  }
  return spans.lines
    .find((line) => line.spans.some((span) => /\d\d:\d\d:\d\d {2}step/.test(span.text) && span.attributes & 1))
    ?.spans.map((span) => span.text)
    .join("")
    .match(/(\d\d:\d\d:\d\d) {2}step/)?.[1]
}

const time = (index: number) => {
  const date = new Date(NOW - index * 1000)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":")
}

describe("the cards (section 3)", () => {
  test("a miss with a red edge, a partial reuse with a yellow one: what was lost, the age and ×, the chat, the cause", async () => {
    await using setup = await cards({
      notices: [
        notice(0),
        notice(1, {
          verdict: "partial",
          tokens: 18_000,
          sessionID: SUBAGENT,
          rootID: CHAT,
          title: "Write the docs",
          agent: "docs",
          model: "claude-haiku-4-5",
          cause: "partial reuse · tools",
        }),
      ],
    })
    const frame = await setup.frame((frame) => frame.includes(TITLE))
    const line = (text: string) => frame.split("\n").find((line) => line.includes(text))!
    expect(line(TITLE)).toMatch(/Cache miss · 152K tokens not reused +just now × +┃/)
    expect(frame).toContain("Fix the flaky test · build · claude-opus-4-5")
    expect(frame).toContain("prefix changed · system")
    expect(line("Partial cache reuse")).toMatch(/Partial cache reuse · 18K tokens not reused +just now × +┃/)
    expect(frame).toContain("Write the docs · docs · claude-haiku-4-5")
    expect(frame).toContain("partial reuse · tools")
    // Newest first.
    expect(frame.indexOf(TITLE)).toBeLessThan(frame.indexOf("Partial cache reuse"))
    expect(edgeOf(setup, TITLE)).toEqual(setup.theme.text.feedback.error.base.toInts())
    expect(edgeOf(setup, "Partial cache reuse")).toEqual(setup.theme.text.feedback.warning.base.toInts())
    // In the top-right corner, 64 columns wide at most: from its left edge to its right one, two columns from the right.
    const row = line(TITLE)
    expect(row.lastIndexOf("┃")).toBe(120 - 3)
    expect(row.lastIndexOf("┃") - row.indexOf("┃") + 1).toBe(64)
    expect(frame.split("\n").findIndex((line) => line.includes(TITLE))).toBe(1)
  })

  test("a row CPP gave no count shows none", async () => {
    await using setup = await cards({ notices: [notice(0, { tokens: undefined })] })
    const frame = await setup.frame((frame) => frame.includes("Fix the flaky test"))
    expect(frame).toMatch(/┃ Cache miss +just now × +┃/)
    expect(frame).not.toContain("tokens not reused")
  })

  test("at most 4 cards, then +N more cache notices", async () => {
    await using setup = await cards({ notices: Array.from({ length: 6 }, (_, index) => notice(index)) })
    const frame = await setup.frame((frame) => frame.includes("more cache notices"))
    expect(count(frame, TITLE)).toBe(4)
    expect(frame).toContain("+2 more cache notices")
  })

  test("over a chat's text, the cards and the line under them read whole", async () => {
    // Found in the frames of tui-1: the line's spaces let the transcript through ("+2tmoreacache…").
    const fake = pacerFake()
    fake.status = status("on")
    fake.notices = Array.from({ length: 6 }, (_, index) => notice(index))
    await using setup = await renderPacer({
      fake,
      width: 120,
      height: 40,
      content: () => (
        <box width="100%" height="100%">
          <text>{"Text of the chat beneath. ".repeat(160)}</text>
          <PacerNotices />
        </box>
      ),
    })
    const frame = await setup.frame((frame) => frame.includes("Fix the flaky test"))
    expect(frame).toContain("+2 more cache notices")
    expect(frame).toContain("┃ Cache miss · 152K tokens not reused              just now ×  ┃")
    expect(frame).toContain("┃ Fix the flaky test · build · claude-opus-4-5                 ┃")
  })

  test("a short terminal shows fewer cards", async () => {
    for (const [height, shown] of [
      [16, 2],
      [10, 1],
    ] as const) {
      await using setup = await cards({
        height,
        notices: Array.from({ length: 6 }, (_, index) => notice(index)),
      })
      const frame = await setup.frame((frame) => frame.includes("more cache notices"))
      expect(count(frame, TITLE)).toBe(shown)
      expect(frame).toContain(`+${6 - shown} more cache notices`)
    }
  })

  test("a narrow terminal narrows the card and cuts its lines", async () => {
    await using setup = await cards({
      width: 40,
      notices: [notice(0, { title: "Fix the flaky test in the session list once and for all" })],
    })
    const frame = await setup.frame((frame) => frame.includes("Cache miss"))
    const row = frame.split("\n").find((line) => line.includes("Cache miss"))!
    expect(row.lastIndexOf("┃") - row.indexOf("┃") + 1).toBe(34)
    // Each line is cut at its end; the age and × keep their place.
    expect(row).toContain("┃ Cache miss · 152K… just now ×  ┃")
    expect(frame).toContain("┃ Fix the flaky test in the ses… ┃")
  })

  test("a new notice comes on top; one dismissed in another TUI goes", async () => {
    await using setup = await cards()
    await setup.frame((frame) => frame.includes(TITLE))
    setup.emit({
      type: "pacer.notice.added",
      data: { notice: notice(-1, { verdict: "partial", tokens: 2_000, title: "Newer chat" }) },
    })
    const frame = await setup.frame((frame) => frame.includes("Newer chat"))
    expect(frame.indexOf("Partial cache reuse · 2K tokens not reused")).toBeLessThan(frame.indexOf(TITLE))
    setup.emit({ type: "pacer.notice.dismissed", data: { requestID: "req_-1" } })
    await setup.frame((frame) => !frame.includes("Newer chat") && frame.includes(TITLE))
  })

  test("the ages count while cards show, and a notice past its lifetime goes; nothing ticks while none show", async () => {
    const clock = new ManualClock()
    clock.setTime(NOW)
    const fake = pacerFake()
    fake.status = status("on")
    const setup = await renderPacer({ fake, clock, content: () => <PacerNotices /> })
    await using _ = setup
    await setup.settle()
    expect(setup.pacer.ticking()).toBe(false)
    setup.emit({ type: "pacer.notice.added", data: { notice: notice(0) } })
    await setup.frame((frame) => frame.includes("just now"))
    expect(setup.pacer.ticking()).toBe(true)
    clock.advance(3 * 60_000)
    await setup.frame((frame) => frame.includes("3 min ago"))
    // The lifetime is 15 minutes by default: at 15 the card goes, and with it the clock.
    clock.advance(12 * 60_000 - 1_000)
    await setup.frame((frame) => frame.includes("14 min ago"))
    expect(setup.pacer.ticking()).toBe(true)
    clock.advance(1_000)
    await setup.frame((frame) => !frame.includes("Cache miss"))
    expect(setup.pacer.ticking()).toBe(false)
    // A notice arriving past its lifetime shows no card and starts no clock.
    setup.emit({ type: "pacer.notice.added", data: { notice: notice(1, { at: NOW - 60_000 }) } })
    await until(() => setup.pacer.notices().length === 2, 5_000, "the late notice held")
    await Bun.sleep(20)
    expect(setup.app.captureCharFrame()).not.toContain("Cache miss")
    expect(setup.pacer.ticking()).toBe(false)
  })
})

describe("open and dismiss (section 3)", () => {
  test("a click opens the notice: its chat, the Requests tab on its request with what changed, the notice dismissed", async () => {
    await using setup = await cards({ route: OTHER, notices: [notice(3), notice(5)] })
    await setup.frame((frame) => frame.includes("transcript of ses_other") && frame.includes(TITLE))
    await click(setup, TITLE)
    const frame = await setup.frame((frame) => frame.includes("compared with req_prev"))
    expect(setup.route.data).toEqual({ type: "session", sessionID: CHAT })
    expect(frame).toContain("transcript of ses_chat")
    expect(frame).toContain("miss · prefix changed · system changed")
    expect(frame).toContain("98.1K tokens written again · the miss cost $0.41")
    await until(() => dismissals(setup).length === 1, 5_000, "the dismissal")
    expect(dismissals(setup)).toEqual(["notices/req_3/dismiss"])
    // The other notice stays.
    expect(count(frame, TITLE)).toBe(1)
    // Back from what changed, the cursor is on the request's row.
    setup.app.mockInput.pressEscape()
    await setup.frame(() => selectedRow(setup) === time(3))
  })

  test("<leader>o opens the newest notice", async () => {
    await using setup = await cards({ route: OTHER, notices: [notice(3), notice(5)] })
    await setup.frame((frame) => frame.includes(TITLE))
    setup.app.mockInput.pressKey("x", { ctrl: true })
    setup.app.mockInput.pressKey("o")
    await setup.frame((frame) => frame.includes("compared with req_prev"))
    expect(setup.route.data).toEqual({ type: "session", sessionID: CHAT })
    await until(() => dismissals(setup).length === 1, 5_000, "the dismissal")
    expect(dismissals(setup)).toEqual(["notices/req_3/dismiss"])
  })

  test("a subagent's notice opens the subagent's chat, the one that sent the request", async () => {
    await using setup = await cards({ notices: [notice(3, { sessionID: SUBAGENT, rootID: CHAT })] })
    setup.fake.chats[SUBAGENT] = chat({ sessionID: SUBAGENT })
    setup.fake.requests[SUBAGENT] = [miss(3, { sessionID: SUBAGENT })]
    await setup.frame((frame) => frame.includes(TITLE))
    await click(setup, TITLE)
    await setup.frame(
      (frame) => frame.includes("transcript of ses_subagent") && frame.includes("compared with req_prev"),
    )
    expect(setup.route.data).toEqual({ type: "session", sessionID: SUBAGENT })
  })

  test("the composer open on another tab comes to Requests", async () => {
    await using setup = await cards({ notices: [notice(3)] })
    await setup.frame((frame) => frame.includes(TITLE))
    setup.pacer.openRequests(CHAT)
    await setup.frame((frame) => frame.includes("read/write"))
    setup.app.mockInput.pressArrow("left")
    await setup.frame((frame) => !frame.includes("read/write"))
    await click(setup, TITLE)
    await setup.frame((frame) => frame.includes("compared with req_prev"))
  })

  test("× dismisses it in every TUI", async () => {
    await using setup = await cards({ notices: [notice(3), notice(5)] })
    await setup.frame((frame) => count(frame, TITLE) === 2)
    await click(setup, "×")
    await setup.frame((frame) => count(frame, TITLE) === 1)
    expect(dismissals(setup)).toEqual(["notices/req_3/dismiss"])
    // Nothing opened.
    expect(setup.app.captureCharFrame()).not.toContain("read/write")
    expect(setup.pacer.reveal()).toBeUndefined()
  })

  test("the palette's Dismiss cache notices dismisses all of them, and shows only while cards do", async () => {
    await using setup = await cards({ notices: Array.from({ length: 6 }, (_, index) => notice(index)) })
    await setup.frame((frame) => frame.includes(TITLE))
    expect(setup.palette()).toContain("Dismiss cache notices")
    setup.dispatch("pacer.notices.dismiss")
    await setup.frame((frame) => !frame.includes("Cache miss"))
    await until(() => dismissals(setup).length === 6, 5_000, "six dismissals")
    expect(dismissals(setup).toSorted()).toEqual(
      Array.from({ length: 6 }, (_, index) => `notices/req_${index}/dismiss`).toSorted(),
    )
    await until(() => !setup.palette().includes("Dismiss cache notices"), 5_000, "no palette entry")
  })

  test("behind a dialog the cards wait: <leader>o opens nothing, a click closes the dialog", async () => {
    await using setup = await cards({ route: OTHER, notices: [notice(3)] })
    await setup.frame((frame) => frame.includes(TITLE))
    setup.dialog.replace(() => <text>A dialog over the screen</text>)
    await setup.frame((frame) => frame.includes("A dialog over the screen"))
    setup.app.mockInput.pressKey("x", { ctrl: true })
    setup.app.mockInput.pressKey("o")
    await click(setup, TITLE)
    await setup.frame((frame) => !frame.includes("A dialog over the screen"))
    await Bun.sleep(30)
    expect(setup.route.data).toEqual({ type: "session", sessionID: OTHER })
    expect(dismissals(setup)).toEqual([])
    expect(setup.app.captureCharFrame()).toContain(TITLE)
    // With the dialog gone the key opens it.
    setup.app.mockInput.pressKey("x", { ctrl: true })
    setup.app.mockInput.pressKey("o")
    await setup.frame((frame) => frame.includes("compared with req_prev"))
  })
})

describe("settings (section 4)", () => {
  test("six rows under CLIProxyPacer, with OpenCodePlus's choices and defaults", () => {
    const rows = settings.filter((setting) => setting.category === "CLIProxyPacer")
    const shown = (setting: (typeof rows)[number], value: unknown) =>
      setting.labels?.[setting.values!.indexOf(value)] ?? String(value)
    expect(
      rows.map((setting) => ({
        title: setting.title,
        path: setting.path.join("."),
        choices: setting.values!.map((value) => shown(setting, value)),
        default: shown(setting, setting.default),
      })),
    ).toEqual([
      {
        title: "Cache notices",
        path: "cliproxypacer.notices.enabled",
        choices: ["off", "on"],
        default: "on",
      },
      {
        title: "Cache notices from",
        path: "cliproxypacer.notices.from",
        choices: ["all chats", "this chat and its subagents"],
        default: "all chats",
      },
      {
        title: "Cache notice lifetime",
        path: "cliproxypacer.notices.lifetime",
        choices: ["15 minutes", "30 minutes", "60 minutes", "120 minutes"],
        default: "15 minutes",
      },
      {
        title: "Cache notice minimum",
        path: "cliproxypacer.notices.minimum",
        choices: ["any loss", "1K tokens", "10K tokens", "50K tokens", "100K tokens"],
        default: "any loss",
      },
      {
        title: "Cache notices for",
        path: "cliproxypacer.notices.kinds",
        choices: ["misses and partial reuse", "misses only"],
        default: "misses and partial reuse",
      },
      {
        title: "Opened cache notice disappears",
        path: "cliproxypacer.notices.dismiss",
        choices: ["in every TUI", "only in this TUI"],
        default: "in every TUI",
      },
    ])
    // The cards use the defaults the rows show.
    const defaults = noticeSettings(undefined)
    const used: unknown[] = rows.map((setting) => defaults[setting.path.at(-1) as keyof typeof defaults])
    expect(used).toEqual(rows.map((setting) => setting.default))
  })

  const all = noticeSettings(undefined)
  const visible = (
    notices: PacerNotice[],
    change: Partial<typeof all> = {},
    input: { now?: number; root?: string; dismissed?: Record<string, number> } = {},
  ) =>
    visibleNotices(notices, { ...all, ...change }, { now: NOW, dismissed: {}, ...input }).map(
      (notice) => notice.requestID,
    )

  test("Cache notices off: no card", () => {
    expect(visible([notice(0)], { enabled: false })).toEqual([])
  })

  test("Cache notices from this chat: the shown chat's and its subagents', by their top chat", () => {
    const notices = [
      notice(0),
      notice(1, { sessionID: SUBAGENT, rootID: CHAT }),
      notice(2, { sessionID: OTHER, rootID: OTHER }),
    ]
    expect(visible(notices)).toEqual(["req_0", "req_1", "req_2"])
    expect(visible(notices, { from: "chat" }, { root: CHAT })).toEqual(["req_0", "req_1"])
    expect(visible(notices, { from: "chat" }, { root: OTHER })).toEqual(["req_2"])
    // No chat shown: none.
    expect(visible(notices, { from: "chat" })).toEqual([])
  })

  test("Cache notice lifetime: a notice shows that many minutes after its request", () => {
    const notices = [notice(0, { at: NOW - 14 * 60_000 }), notice(1, { at: NOW - 20 * 60_000 })]
    expect(visible(notices)).toEqual(["req_0"])
    expect(visible(notices, { lifetime: 30 })).toEqual(["req_0", "req_1"])
    // At 15 minutes a 15-minute notice is gone: the last age it shows is 14 min ago.
    expect(visible(notices, { lifetime: 15 }, { now: NOW + 59_999 })).toEqual(["req_0"])
    expect(visible(notices, { lifetime: 15 }, { now: NOW + 60_000 })).toEqual([])
  })

  test("Cache notice minimum: fewer tokens not reused show none; a row without its count counts as any loss", () => {
    const notices = [notice(0, { tokens: 152_340 }), notice(1, { tokens: 9_999 }), notice(2, { tokens: undefined })]
    expect(visible(notices)).toEqual(["req_0", "req_1", "req_2"])
    expect(visible(notices, { minimum: 1_000 })).toEqual(["req_0", "req_1"])
    expect(visible(notices, { minimum: 10_000 })).toEqual(["req_0"])
    expect(visible(notices, { minimum: 100_000 })).toEqual(["req_0"])
  })

  test("Cache notices for misses only: no partial reuse", () => {
    const notices = [notice(0), notice(1, { verdict: "partial" })]
    expect(visible(notices)).toEqual(["req_0", "req_1"])
    expect(visible(notices, { kinds: "misses" })).toEqual(["req_0"])
  })

  test("a notice dismissed in this TUI alone shows no more in it", () => {
    expect(visible([notice(0), notice(1)], {}, { dismissed: { req_0: NOW } })).toEqual(["req_1"])
  })

  test("Cache notices off: nothing is read and no card shows; on again, they are read", async () => {
    await using setup = await cards({ config: { cliproxypacer: { notices: { enabled: false } } } })
    await setup.settle()
    expect(reads(setup)).toEqual([])
    expect(setup.app.captureCharFrame()).not.toContain("Cache miss")
    await setup.configure((draft) => (draft.cliproxypacer = { notices: { enabled: true } }))
    await setup.frame((frame) => frame.includes(TITLE))
    expect(reads(setup)).toHaveLength(1)
    // A notice that comes while they are off is not held.
    await setup.configure((draft) => (draft.cliproxypacer = { notices: { enabled: false } }))
    await setup.frame((frame) => !frame.includes("Cache miss"))
    setup.emit({ type: "pacer.notice.added", data: { notice: notice(-1) } })
    await Bun.sleep(30)
    expect(setup.pacer.notices()).toEqual([])
  })

  test("Cache notices from this chat follow the chat shown", async () => {
    await using setup = await cards({
      config: { cliproxypacer: { notices: { from: "chat" } } },
      notices: [notice(0, { sessionID: OTHER, rootID: OTHER, title: "The other chat" }), notice(1)],
    })
    await setup.frame((frame) => frame.includes("Fix the flaky test"))
    expect(setup.app.captureCharFrame()).not.toContain("The other chat")
    // In the subagent's chat, its top chat's notices still show.
    setup.route.navigate({ type: "session", sessionID: SUBAGENT })
    await setup.frame((frame) => frame.includes("transcript of ses_subagent") && frame.includes("Fix the flaky test"))
    setup.route.navigate({ type: "session", sessionID: OTHER })
    await setup.frame((frame) => frame.includes("The other chat") && !frame.includes("Fix the flaky test"))
  })

  test("a setting changed applies at once to the cards on screen", async () => {
    await using setup = await cards({
      notices: [notice(0), notice(1, { verdict: "partial", tokens: 18_000, title: "Partly reused" })],
    })
    await setup.frame((frame) => frame.includes("Partly reused"))
    await setup.configure((draft) => (draft.cliproxypacer = { notices: { kinds: "misses" } }))
    await setup.frame((frame) => !frame.includes("Partly reused") && frame.includes(TITLE))
    await setup.configure((draft) => (draft.cliproxypacer = { notices: { minimum: 10_000 } }))
    await setup.frame((frame) => frame.includes(TITLE) && frame.includes("Partly reused"))
    await setup.configure((draft) => (draft.cliproxypacer = { notices: { minimum: 50_000 } }))
    await setup.frame((frame) => frame.includes(TITLE) && !frame.includes("Partly reused"))
    await setup.configure((draft) => (draft.cliproxypacer = { notices: { lifetime: 30, enabled: false } }))
    await setup.frame((frame) => !frame.includes("Cache miss") && !frame.includes("Partial cache reuse"))
  })

  test("Opened cache notice disappears only in this TUI: none sent, kept in this TUI's storage for a day", async () => {
    const config = { cliproxypacer: { notices: { dismiss: "this-tui" as const } } }
    await using setup = await cards({ config, route: OTHER, notices: [notice(3), notice(5)] })
    await using other = await cards({ notices: [notice(3), notice(5)] })
    setup.fake.prompts.req_5 = promptChange(request(5))
    await setup.frame((frame) => count(frame, TITLE) === 2)
    await other.frame((frame) => count(frame, TITLE) === 2)
    const file = path.join(setup.state, "test", "tui", "pacer-notices.json")
    // A dismissal older than a day is dropped at the next one; a younger one is kept.
    await writeFile(
      file,
      JSON.stringify({ dismissed: { req_old: Date.now() - 25 * 3_600_000, req_young: Date.now() - 23 * 3_600_000 } }),
    )
    await click(setup, "×")
    await setup.frame((frame) => count(frame, TITLE) === 1)
    // Opened, the other one goes too.
    await click(setup, TITLE)
    await setup.frame((frame) => frame.includes("compared with req_prev") && !frame.includes("Cache miss"))
    const kept = () => Object.keys(JSON.parse(readFileSync(file, "utf8")).dismissed).toSorted()
    await until(() => kept().length === 3, 5_000, "both kept")
    expect(kept()).toEqual(["req_3", "req_5", "req_young"])
    expect(dismissals(setup)).toEqual([])
    // The service still holds both, and the other TUI shows both.
    expect(setup.pacer.notices().map((notice) => notice.requestID)).toEqual(["req_3", "req_5"])
    expect(count(other.app.captureCharFrame(), TITLE)).toBe(2)
  })
})

describe("without CLIProxyPacer", () => {
  test("nothing is read and nothing shows", async () => {
    await using setup = await cards({ state: "unset" })
    await setup.settle()
    expect(reads(setup)).toEqual([])
    setup.emit({ type: "pacer.notice.added", data: { notice: notice(0) } })
    await Bun.sleep(30)
    expect(setup.app.captureCharFrame()).not.toContain("Cache miss")
    expect(setup.palette()).toEqual([])
  })

  test("the notices go when CLIProxyPacer is no longer set up", async () => {
    await using setup = await cards()
    await setup.frame((frame) => frame.includes(TITLE))
    setup.emit({ type: "pacer.status", data: { status: status("unset") } })
    await setup.frame((frame) => !frame.includes("Cache miss"))
    expect(colorOf(setup.app, TITLE)).toBeUndefined()
  })
})
