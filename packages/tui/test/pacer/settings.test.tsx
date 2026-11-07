/** @jsxImportSource @opentui/solid */
import type { PacerSettings } from "@opencode/client"
import { expect, test } from "bun:test"
import { CommandPaletteDialog } from "../../src/component/command-palette"
import { DialogConfig } from "../../src/component/dialog-config"
import { useDialog } from "../../src/ui/dialog"
import { Toast } from "../../src/ui/toast"
import { pacerFake, renderPacer, status } from "./fixture"

// Section 2 of spec cliproxypacer-cold-ask, its first bullet: Settings › CLIProxyPacer has two rows, CLIProxyPacer's
// settings for all your chats, read from it when Settings opens, flipped with Enter, and shown only while a
// CLIProxyPacer is set up and answering. A failed write toasts the error.

async function settings(
  input: { state?: Parameters<typeof status>[0]; newDesigns?: boolean; values?: PacerSettings } = {},
) {
  const fake = pacerFake()
  fake.status = status(input.state ?? "on")
  fake.settings = input.values ?? { compactColdFirst: true, compactBeforeCold: false }
  let dialog!: ReturnType<typeof useDialog>
  function Dialog() {
    dialog = useDialog()
    return null
  }
  // Tall enough for every row of Settings at once.
  const setup = await renderPacer({
    fake,
    width: 100,
    height: 140,
    newDesigns: input.newDesigns,
    content: () => (
      <>
        <Dialog />
        <Toast />
      </>
    ),
  })
  const reads = () => fake.calls.filter((call) => call.path === "settings" && call.method === "GET").length
  const writes = () =>
    fake.calls.filter((call) => call.path === "settings" && call.method === "PATCH").map((call) => call.body)
  return {
    ...setup,
    fake,
    reads,
    writes,
    open: (current?: string) => dialog.replace(() => <DialogConfig current={current} />),
    palette: () => dialog.replace(() => <CommandPaletteDialog />),
    close: () => dialog.clear(),
  }
}

/** A row and its value; the new designs draw the selected row's value as `‹ on ›`. */
const row = (title: string, value: string) => new RegExp(`${title} +(‹ )?${value}\\b`)

test("Settings › CLIProxyPacer: both rows, with what CLIProxyPacer has for your chats, read each time Settings opens", async () => {
  await using setup = await settings()
  await setup.settle()
  expect(setup.reads()).toBe(0)
  setup.open()
  const first = await setup.frame((frame) => frame.includes("Compact cold chats first"))
  expect(first).toMatch(/^\s*CLIProxyPacer\s*$/m)
  expect(first).toMatch(row("Compact cold chats first", "on"))
  expect(first).toMatch(row("Compact before cold", "off"))
  expect(setup.reads()).toBe(1)
  setup.close()
  await setup.frame((frame) => !frame.includes("Compact cold chats first"))
  // Changed on CLIProxyPacer meanwhile, as from its dashboard: the next opening reads it again and shows it.
  setup.fake.settings = { compactColdFirst: false, compactBeforeCold: true }
  setup.open()
  const second = await setup.frame((frame) => frame.includes("Compact cold chats first"))
  expect(second).toMatch(row("Compact cold chats first", "off"))
  expect(second).toMatch(row("Compact before cold", "on"))
  expect(setup.reads()).toBe(2)
  expect(setup.writes()).toEqual([])
})

test("Enter flips a row on CLIProxyPacer, and the row shows its answer", async () => {
  await using setup = await settings()
  setup.open("cliproxypacer.compact_cold_first")
  await setup.frame((frame) => row("Compact cold chats first", "on").test(frame))
  setup.app.mockInput.pressEnter()
  await setup.frame((frame) => row("Compact cold chats first", "off").test(frame))
  expect(setup.writes()).toEqual([{ compactColdFirst: false }])
  setup.app.mockInput.pressArrow("down")
  setup.app.mockInput.pressEnter()
  await setup.frame((frame) => row("Compact before cold", "on").test(frame))
  expect(setup.writes()).toEqual([{ compactColdFirst: false }, { compactBeforeCold: true }])
  expect(setup.fake.settings).toEqual({ compactColdFirst: false, compactBeforeCold: true })
  expect(setup.app.captureCharFrame()).toMatch(row("Compact cold chats first", "off"))
})

test("a write keeps the selection where the keys moved it, not at the row Settings opened at", async () => {
  await using setup = await settings()
  setup.open("cliproxypacer.compact_cold_first")
  await setup.frame((frame) => row("Compact cold chats first", "on").test(frame))
  setup.app.mockInput.pressArrow("down")
  setup.app.mockInput.pressEnter()
  await setup.frame((frame) => row("Compact before cold", "on").test(frame))
  // From Compact before cold, the row above is Compact cold chats first.
  setup.app.mockInput.pressArrow("up")
  setup.app.mockInput.pressEnter()
  await setup.frame(() => setup.writes().length === 2)
  expect(setup.writes()).toEqual([{ compactBeforeCold: true }, { compactColdFirst: false }])
})

test("under the new designs too: opened at a row, Enter flips it, and the row says what it does", async () => {
  await using setup = await settings({ newDesigns: true })
  setup.open("cliproxypacer.compact_before_cold")
  // The selected row's description, under the list.
  await setup.frame((frame) => frame.includes("For all chats: whether an idle chat compacts on its"))
  expect(setup.app.captureCharFrame()).toMatch(/┃ +Compact before cold +‹ off ›/)
  setup.app.mockInput.pressEnter()
  await setup.frame(() => setup.writes().length === 1)
  expect(setup.writes()).toEqual([{ compactBeforeCold: true }])
  await setup.frame((frame) => row("Compact before cold", "on").test(frame))
})

test("one CLIProxyPacer heading over the cache notices' six rows and these two, all shown only while it answers", async () => {
  await using setup = await settings()
  setup.open()
  const lines = (await setup.frame((frame) => frame.includes("Compact cold chats first")))
    .split("\n")
    .map((line) => line.trim())
  expect(lines.filter((line) => line === "CLIProxyPacer")).toHaveLength(1)
  const heading = lines.indexOf("CLIProxyPacer")
  // The heading's rows, up to the blank line before the next heading, by title.
  expect(lines.slice(heading + 1, lines.indexOf("", heading)).map((line) => line.replace(/\s{2,}.*$/, ""))).toEqual([
    "Cache notices",
    "Cache notices from",
    "Cache notice lifetime",
    "Cache notice minimum",
    "Cache notices for",
    "Opened cache notice disappears",
    "Compact cold chats first",
    "Compact before cold",
  ])

  // The cache notices' rows are this TUI's own, but tune only what CLIProxyPacer sends: they go with it.
  await using away = await settings({ state: "unreachable" })
  away.open()
  const frame = await away.frame((frame) => frame.includes("Developer tools"))
  expect(frame).not.toContain("Cache notice")
  expect(frame).not.toContain("CLIProxyPacer")
})

test("no rows without a CLIProxyPacer that answers: none set up, a plain proxy, unreachable, or its settings refused", async () => {
  for (const state of ["unset", "no-pacer", "unreachable"] as const) {
    await using setup = await settings({ state })
    setup.open()
    const frame = await setup.frame((frame) => frame.includes("Developer tools"))
    expect(frame).not.toContain("CLIProxyPacer")
    expect(frame).not.toContain("Compact")
    expect(setup.reads()).toBe(0)
  }
  await using setup = await settings()
  setup.fake.unavailable = true
  setup.open()
  await setup.frame((frame) => frame.includes("Developer tools"))
  await setup.settle()
  expect(setup.reads()).toBe(1)
  expect(setup.app.captureCharFrame()).not.toContain("Compact")
})

test("the rows go while CLIProxyPacer can't be reached, and come back read again", async () => {
  await using setup = await settings()
  setup.open()
  await setup.frame((frame) => row("Compact cold chats first", "on").test(frame))
  setup.emit({ type: "pacer.status", data: { status: status("unreachable") } })
  await setup.frame((frame) => frame.includes("Developer tools") && !frame.includes("Compact"))
  setup.fake.settings = { compactColdFirst: false, compactBeforeCold: false }
  setup.emit({ type: "pacer.status", data: { status: status("on") } })
  await setup.frame((frame) => row("Compact cold chats first", "off").test(frame))
  expect(setup.reads()).toBe(2)
})

test("a failed write toasts the error, and the row keeps its value", async () => {
  await using setup = await settings()
  setup.open("cliproxypacer.compact_cold_first")
  await setup.frame((frame) => row("Compact cold chats first", "on").test(frame))
  setup.fake.unavailable = true
  setup.app.mockInput.pressEnter()
  await setup.frame((frame) => frame.includes("CLIProxyPacer can't answer: it is not on"))
  expect(setup.writes()).toEqual([{ compactColdFirst: false }])
  expect(setup.app.captureCharFrame()).toMatch(row("Compact cold chats first", "on"))
})

test("the command palette finds the rows only while CLIProxyPacer answers", async () => {
  for (const [state, shown] of [
    ["on", true],
    ["unset", false],
  ] as const) {
    await using setup = await settings({ state })
    setup.palette()
    await setup.frame((frame) => frame.includes("Commands"))
    // The filter takes the keys once it has the focus.
    await Bun.sleep(50)
    await setup.app.mockInput.typeText("Compact before")
    await setup.frame((frame) => frame.includes("Compact before"))
    await Bun.sleep(30)
    await setup.app.renderOnce()
    expect(setup.app.captureCharFrame().includes("Settings · CLIProxyPacer")).toBe(shown)
  }
})

// Section 2 of spec cliproxypacer-server-summaries: two more rows, Summaries written by and Keep my messages in
// summaries, read, shown and written as the two above; each hidden while the service's answer lacks it.

const summaries: PacerSettings = {
  compactColdFirst: false,
  compactBeforeCold: false,
  summaryWriter: "cliproxypacer",
  keepUserMessages: false,
}

test("Summaries written by and Keep my messages in summaries, after the other two, with what CLIProxyPacer has", async () => {
  await using setup = await settings({ values: summaries })
  setup.open()
  const frame = await setup.frame((frame) => frame.includes("Summaries written by"))
  expect(frame).toMatch(row("Summaries written by", "CLIProxyPacer"))
  expect(frame).toMatch(row("Keep my messages in summaries", "off"))
  // The category's header, then its four rows in order.
  const lines = frame.split("\n").map((line) => line.trim())
  const header = lines.indexOf("CLIProxyPacer")
  expect(header).toBeGreaterThan(0)
  expect(lines.slice(header + 1, header + 5).map((line) => line.replace(/ {2,}.*$/, ""))).toEqual([
    "Compact cold chats first",
    "Compact before cold",
    "Summaries written by",
    "Keep my messages in summaries",
  ])
})

test("Enter switches who writes the summaries and whether they keep your messages, on CLIProxyPacer", async () => {
  await using setup = await settings({ values: summaries })
  setup.open("cliproxypacer.summary_writer")
  await setup.frame((frame) => row("Summaries written by", "CLIProxyPacer").test(frame))
  setup.app.mockInput.pressEnter()
  await setup.frame((frame) => row("Summaries written by", "openforge").test(frame))
  expect(setup.writes()).toEqual([{ summaryWriter: "openforge" }])
  setup.app.mockInput.pressArrow("down")
  setup.app.mockInput.pressEnter()
  await setup.frame((frame) => row("Keep my messages in summaries", "on").test(frame))
  setup.app.mockInput.pressArrow("up")
  setup.app.mockInput.pressEnter()
  await setup.frame((frame) => row("Summaries written by", "CLIProxyPacer").test(frame))
  expect(setup.writes()).toEqual([
    { summaryWriter: "openforge" },
    { keepUserMessages: true },
    { summaryWriter: "cliproxypacer" },
  ])
  expect(setup.fake.settings).toEqual({ ...summaries, keepUserMessages: true })
})

test("each of the two is hidden while the service's answer lacks it; the others show", async () => {
  const asks = { compactColdFirst: false, compactBeforeCold: false }
  for (const [values, writer, keep] of [
    [{ ...asks, keepUserMessages: false }, false, true],
    [{ ...asks, summaryWriter: "cliproxypacer" }, true, false],
    [asks, false, false],
  ] as const) {
    await using setup = await settings({ values })
    setup.open()
    const frame = await setup.frame((frame) => frame.includes("Compact before cold"))
    await setup.settle()
    expect(frame).toMatch(row("Compact cold chats first", "off"))
    expect(frame.includes("Summaries written by")).toBe(writer)
    expect(frame.includes("Keep my messages in summaries")).toBe(keep)
  }
})

test("a failed write of who writes the summaries toasts the error, and the row keeps its value", async () => {
  await using setup = await settings({ values: summaries })
  setup.open("cliproxypacer.summary_writer")
  await setup.frame((frame) => row("Summaries written by", "CLIProxyPacer").test(frame))
  setup.fake.unavailable = true
  setup.app.mockInput.pressEnter()
  await setup.frame((frame) => frame.includes("CLIProxyPacer can't answer: it is not on"))
  expect(setup.writes()).toEqual([{ summaryWriter: "openforge" }])
  expect(setup.app.captureCharFrame()).toMatch(row("Summaries written by", "CLIProxyPacer"))
})
