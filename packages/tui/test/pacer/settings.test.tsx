/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { CommandPaletteDialog } from "../../src/component/command-palette"
import { DialogConfig } from "../../src/component/dialog-config"
import { useDialog } from "../../src/ui/dialog"
import { Toast } from "../../src/ui/toast"
import { pacerFake, renderPacer, status } from "./fixture"

// Section 2 of spec cliproxypacer-cold-ask, its first bullet: Settings › CLIProxyPacer has two rows, CLIProxyPacer's
// settings for all your chats, read from it when Settings opens, flipped with Enter, and shown only while a
// CLIProxyPacer is set up and answering. A failed write toasts the error.

async function settings(input: { state?: Parameters<typeof status>[0]; newDesigns?: boolean } = {}) {
  const fake = pacerFake()
  fake.status = status(input.state ?? "on")
  fake.settings = { compactColdFirst: true, compactBeforeCold: false }
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
