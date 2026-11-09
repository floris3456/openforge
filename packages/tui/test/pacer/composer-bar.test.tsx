/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { usePacerSession } from "../../src/pacer/jump"
import { Composer } from "../../src/routes/session/composer"
import { composerBar } from "../../src/routes/session/composer/bar"
import { recordFrames, type RecordedFrame } from "../fixture/frames"
import { until } from "../fixture/wait"
import { CHAT, chat, pacerFake, renderPacer, request, status } from "./fixture"

// The composer's tab bar and hint line stay one line each in a narrow window: CLIProxyPacer's Requests tab is a
// fourth tab (spec cliproxypacer-step-1, section 7), which made both wrap label by label at 45 columns.

const labels = ["Subagents", "Shell", "Terminals", "Requests"]
const hints = [
  { label: "go to", shortcut: "enter" },
  { label: "what changed", shortcut: "ctrl+enter" },
  { label: "show misses", shortcut: "ctrl+a" },
]

describe("composerBar", () => {
  test("every tab while they fit beside esc, else the active one; the hints from the first while they fit", () => {
    // 80 columns leave the bar 71: everything, and "tabs ←/→".
    expect(composerBar({ width: 71, labels, hints })).toEqual({ all: true, hints, tabs: true })
    // The four labels, two spaces and esc take 42 columns.
    expect(composerBar({ width: 42, labels, hints: [] }).all).toBe(true)
    expect(composerBar({ width: 41, labels, hints: [] }).all).toBe(false)
    // 45 columns leave 36: the active tab alone; the first two hints, exactly.
    expect(composerBar({ width: 36, labels, hints })).toEqual({ all: false, hints: hints.slice(0, 2), tabs: false })
    // 36 columns leave 27.
    expect(composerBar({ width: 27, labels, hints })).toEqual({ all: false, hints: hints.slice(0, 1), tabs: false })
    // The three tabs before the Requests tab fit at 45, as they did.
    const subagents = [{ label: "show inactive", shortcut: "ctrl+a" }]
    expect(composerBar({ width: 36, labels: labels.slice(0, 3), hints: subagents })).toEqual({
      all: true,
      hints: subagents,
      tabs: true,
    })
    // One tab: its label, no tabs hint.
    expect(composerBar({ width: 10, labels: ["Shell"], hints: [] })).toEqual({ all: true, hints: [], tabs: false })
  })
})

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
        <text>transcript</text>
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

/** The composer's lines in a frame: between its top padding and its bottom one, inside its border. */
function composerLines(text: string) {
  return text
    .split("\n")
    .filter((line) => line.trimStart().startsWith("┃"))
    .map((line) => line.trimStart().slice(1).trim())
}

describe("the composer in a narrow window", () => {
  test("draws the bar and the hints on one line each at 45 and 36 columns, in every frame of the resizes", async () => {
    const fake = pacerFake()
    fake.status = status("on")
    fake.chats[CHAT] = chat()
    fake.requests[CHAT] = Array.from({ length: 3 }, (_, index) => request(index))
    await using setup = await renderPacer({
      fake,
      width: 120,
      height: 20,
      content: () => <Session sessionID={CHAT} />,
    })
    await until(() => setup.pacer.page(CHAT, "all") !== undefined, 5_000, "the first page held")
    setup.pacer.openRequests(CHAT)
    await setup.frame((frame) => frame.includes("tabs ←/→") && frame.includes("show misses"))

    // What each width shows, from the bar to the hints (the bar, the list's header, the rows, the hints).
    const expected: Record<number, { bar: RegExp; hints: string }> = {
      120: {
        bar: /^Subagents {2}Shell {2}Requests +esc$/,
        hints: "go to enter  what changed ctrl+enter  show misses ctrl+a  help ?  tabs ←/→",
      },
      45: { bar: /^Subagents {2}Shell {2}Requests +esc$/, hints: "go to enter  what changed ctrl+enter" },
      36: { bar: /^Requests ←\/→ +esc$/, hints: "go to enter" },
    }
    const check = (frame: RecordedFrame, width: number) => {
      const lines = composerLines(frame.text)
      const want = expected[width]!
      const bar = lines.findIndex((line) => line.endsWith("esc"))
      expect(lines[bar]).toMatch(want.bar)
      // Under the bar its gap, then the list; under the hints the composer's bottom padding.
      expect(lines[bar + 1]).toBe("")
      const hint = lines.findIndex((line) => line.startsWith("go to"))
      expect(lines[hint]).toBe(want.hints)
      expect(lines.slice(hint + 1).every((line) => line === "")).toBe(true)
    }
    check({ text: setup.app.captureCharFrame() } as RecordedFrame, 120)

    using recorder = recordFrames(setup.app)
    for (const width of [45, 36, 45, 120, 36]) {
      const mark = recorder.mark()
      setup.app.resize(width, 20)
      await setup.frame((frame) => frame.split("\n")[0]!.length === width && frame.includes("go to enter"))
      await until(() => mark().length > 0, 5_000, `a frame at ${width}`)
      for (const frame of mark()) check(frame, frame.text.split("\n")[0]!.length)
    }
    expect(recorder.missed).toBe(0)
  })
})
