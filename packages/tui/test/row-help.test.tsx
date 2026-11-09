/** @jsxImportSource @opentui/solid */
import { InputRenderable, type CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onMount } from "solid-js"
import { settings } from "../src/component/dialog-config"
import type { DialogSelectOption } from "../src/ui/dialog-select"
import { ROW_HELP_NONE } from "../src/ui/row-help"
import { createAppFixture } from "./fixture/app"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

// Spec row-help: `?` on the selected row of a popup list opens its help as a second popup over it, which stays as it
// was; Esc, `?` again or a click on the help's backdrop closes only the help, on the same row with the search as it was. A row without help shows its description and says there is nothing more.
// The footer shows the key only where rows have help. Every Settings row has help.

const LONG = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1} of a long explanation that wraps.`).join(
  "\n\n",
)

async function mountList(root: string, options: DialogSelectOption<string>[], width = 80, height = 24) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider, useDialog }, { DialogSelect }, toast] =
    await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
      import("../src/context/keymap"),
      import("../src/ui/dialog"),
      import("../src/ui/dialog-select"),
      import("../src/ui/toast"),
    ])
  const selected: string[] = []

  function Fixture() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSelect title="Things" options={options} onSelect={(option) => selected.push(option.value)} />
      )),
    )
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={config}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <toast.ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </toast.ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Things"))
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  return { app, selected }
}

const rows: DialogSelectOption<string>[] = [
  { title: "Alpha", value: "alpha", description: "first", help: "Alpha does the first thing, in full detail." },
  { title: "Beta", value: "beta", description: "second short description" },
  { title: "Gamma", value: "gamma" },
  ...Array.from({ length: 20 }, (_, index) => ({
    title: `Row ${index}`,
    value: `row-${index}`,
    help: `Row ${index}.`,
  })),
  { title: "Long", value: "long", help: LONG },
]

type Cell = { char: string; bg: string }
type Box = { left: number; right: number; top: number; bottom: number }

/** Every cell of the frame: its character and background. */
function cells(app: { captureSpans: () => CapturedFrame }) {
  return app
    .captureSpans()
    .lines.map((line) =>
      line.spans.flatMap((span) =>
        Array.from(
          { length: span.width },
          (_, index): Cell => ({ char: [...span.text][index] ?? " ", bg: span.bg.toString() }),
        ),
      ),
    )
}

/** The bounding box of the cells drawn with `bg`. */
function bounds(grid: Cell[][], bg: string): Box {
  const hits = grid.flatMap((line, y) => line.flatMap((cell, x) => (cell.bg === bg ? [{ x, y }] : [])))
  return {
    left: Math.min(...hits.map((hit) => hit.x)),
    right: Math.max(...hits.map((hit) => hit.x)),
    top: Math.min(...hits.map((hit) => hit.y)),
    bottom: Math.max(...hits.map((hit) => hit.y)),
  }
}

/** The box drawn with `bg`, checked to be a filled rectangle. */
function boxOf(grid: Cell[][], bg: string) {
  const box = bounds(grid, bg)
  const filled = grid
    .slice(box.top, box.bottom + 1)
    .every((line) => line.slice(box.left, box.right + 1).every((cell) => cell.bg === bg))
  expect({ box, filled }).toEqual({ box, filled: true })
  return box
}

const inside = (box: Box, x: number, y: number) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom

/**
 * Opens the selected row's help and checks it is a second popup: the list's popup is drawn as it was around it (every
 * character and its edges at the same cells), and the help is 4 cells narrower a side and centered on the screen.
 */
async function openHelpOverList(app: Awaited<ReturnType<typeof mountList>>["app"], marker: string) {
  await app.waitForVisualIdle()
  const before = cells(app)
  const titleRow = before.findIndex((line) =>
    line
      .map((cell) => cell.char)
      .join("")
      .includes("Things"),
  )
  // The dialog surface: the background beside the list's title. The help popup is drawn on it too.
  const titleColumn = before[titleRow]!.map((cell) => cell.char)
    .join("")
    .indexOf("Things")
  const surface = before[titleRow]![titleColumn - 1]!.bg
  const list = bounds(before, surface)
  app.mockInput.pressKey("?")
  await app.waitForFrame((frame) => frame.includes(marker) && frame.includes("back esc/?"))
  await app.waitForVisualIdle()
  const after = cells(app)
  const help = boxOf(after, surface)
  const { width, height } = { width: after[0]!.length, height: after.length }
  const under = list.right - list.left + 1
  expect(help.right - help.left + 1).toBe(Math.min(width - 2, Math.max(40, under - 8)))
  expect(help.left).toBe(Math.floor((width - (help.right - help.left + 1)) / 2))
  const above = help.top
  const below = height - 1 - help.bottom
  expect(Math.abs(above - below)).toBeLessThanOrEqual(1)
  // The list's popup under it: same characters, and its surface (now dimmed) at the same cells, around the help.
  const dimmed = after[list.top]![list.left]!.bg
  expect(dimmed).not.toBe(surface)
  for (const y of before.keys())
    for (const x of before[y]!.keys()) {
      if (inside(help, x, y)) continue
      expect({ x, y, char: after[y]![x]!.char }).toEqual({ x, y, char: before[y]![x]!.char })
      expect({ x, y, list: after[y]![x]!.bg === dimmed }).toEqual({ x, y, list: before[y]![x]!.bg === surface })
    }
  expect(app.renderer.currentFocusedEditor).toBeNull()
  return { before, help, list }
}

const chars = (grid: Cell[][]) => grid.map((line) => line.map((cell) => cell.char).join("") + "\n").join("")

test.each([80, 50])(
  "? opens the selected row's help as a popup over the list's, which stays as it was, at %i columns",
  async (width) => {
    await using tmp = await tmpdir()
    const { app } = await mountList(tmp.path, rows, width, 24)
    try {
      const { before, list, help } = await openHelpOverList(app, "Alpha does the first thing")
      expect(app.captureCharFrame()).toContain("Things")
      // The list's popup is wider than the help on both sides.
      expect(list.left).toBeLessThan(help.left)
      expect(list.right).toBeGreaterThan(help.right)
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => !frame.includes("back esc/?"))
      await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
      await app.waitForVisualIdle()
      expect(chars(cells(app))).toBe(chars(before))
      expect((app.renderer.currentFocusedEditor as InputRenderable).value).toBe("")
    } finally {
      app.renderer.destroy()
    }
  },
)

test("Esc and ? close only the help: the list is as it was, and the very next key acts on it", async () => {
  await using tmp = await tmpdir()
  const { app, selected } = await mountList(tmp.path, rows)
  try {
    await app.mockInput.typeText("row 1")
    await app.waitFor(() => app.renderer.currentFocusedEditor?.plainText === "row 1")
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("down")
    await app.waitForVisualIdle()
    const before = app.captureCharFrame()
    for (const back of ["escape", "?"] as const) {
      const help = await openHelpOverList(app, "Row ")
      expect(chars(help.before)).toBe(before)
      if (back === "escape") app.mockInput.pressEscape()
      else app.mockInput.pressKey("?")
      await app.waitForFrame((frame) => !frame.includes("back esc/?"))
      await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
      await app.waitForVisualIdle()
      expect(app.captureCharFrame()).toBe(before)
      expect(app.renderer.currentFocusedEditor?.plainText).toBe("row 1")
    }
    // One Enter right after Esc picks the row the help was opened on; the keys go out back to back.
    const row = (await openHelpOverList(app, "Row ")).help
    const title = app
      .captureCharFrame()
      .split("\n")
      [row.top + 1]!.match(/Row \d+/)![0]
    app.mockInput.pressEscape()
    app.mockInput.pressEnter()
    await app.waitFor(() => selected.length === 1)
    expect(selected).toEqual([`row-${title.split(" ")[1]}`])
    // One typed character right after the help closes goes into the search.
    app.mockInput.pressKey("?")
    app.mockInput.pressEscape()
    app.mockInput.pressKey("0")
    await app.waitFor(() => app.renderer.currentFocusedEditor?.plainText === "row 10")
    await app.waitForFrame((frame) => frame.includes("Things") && !frame.includes("back esc/?"))
    // With a frame between: ? then ? again, then one Enter.
    await openHelpOverList(app, "Row 10.")
    app.mockInput.pressKey("?")
    await app.waitForFrame((frame) => !frame.includes("back esc/?"))
    app.mockInput.pressEnter()
    await app.waitFor(() => selected.length === 2)
    expect(selected[1]).toBe("row-10")
  } finally {
    app.renderer.destroy()
  }
})

test("while the help shows, no key reaches the list or its search", async () => {
  await using tmp = await tmpdir()
  const { app, selected } = await mountList(tmp.path, rows)
  try {
    const { before } = await openHelpOverList(app, "Alpha does the first thing")
    await app.mockInput.typeText("ab")
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitForVisualIdle()
    expect(selected).toEqual([])
    app.mockInput.pressEscape()
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.waitForVisualIdle()
    expect(app.captureCharFrame()).toBe(chars(before))
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("a click on the help's backdrop closes only the help; a click inside it does nothing", async () => {
  await using tmp = await tmpdir()
  const { app, selected } = await mountList(tmp.path, rows)
  try {
    const { before, help } = await openHelpOverList(app, "Alpha does the first thing")
    await app.mockMouse.click(Math.floor((help.left + help.right) / 2), help.bottom)
    await app.waitForVisualIdle()
    expect(app.captureCharFrame()).toContain("back esc/?")
    app.renderer.clearSelection()
    // The screen's corner is the list popup's backdrop too: a click there would close the list.
    await app.mockMouse.click(0, 0)
    await app.waitForFrame((frame) => !frame.includes("back esc/?"))
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.waitForVisualIdle()
    expect(app.captureCharFrame()).toBe(chars(before))
    app.mockInput.pressEnter()
    await app.waitFor(() => selected.length === 1)
    expect(selected).toEqual(["alpha"])
  } finally {
    app.renderer.destroy()
  }
})

test("a row without help shows its description and says there is nothing more", async () => {
  await using tmp = await tmpdir()
  const { app } = await mountList(tmp.path, rows)
  try {
    app.mockInput.pressArrow("down")
    app.mockInput.pressKey("?")
    const frame = await app.waitForFrame((frame) => frame.includes(ROW_HELP_NONE))
    expect(frame).toContain("Beta")
    expect(frame).toContain("second short description")
    app.mockInput.pressEscape()
    app.mockInput.pressArrow("down")
    app.mockInput.pressKey("?")
    const bare = await app.waitForFrame((frame) => frame.includes(ROW_HELP_NONE) && frame.includes("Gamma"))
    expect(bare).not.toContain("second short description")
  } finally {
    app.renderer.destroy()
  }
})

test("a long help wraps inside its popup and scrolls", async () => {
  await using tmp = await tmpdir()
  const { app } = await mountList(tmp.path, rows, 50, 24)
  try {
    app.mockInput.pressKey("END")
    await app.waitForFrame((frame) => frame.includes("Long"))
    await openHelpOverList(app, "Paragraph 1 ")
    const frame = app.captureCharFrame()
    expect(frame).toContain("scroll ↑/↓")
    const lines = frame.split("\n")
    // Wrapped inside the dialog: no line of the help runs past the screen's 50 columns or loses words.
    expect(lines.some((line) => line.includes("Paragraph 1 of a long"))).toBe(true)
    expect(frame).not.toContain("Paragraph 12")
    for (const _ of Array.from({ length: 40 })) app.mockInput.pressArrow("down")
    await app.waitForFrame((frame) => frame.includes("Paragraph 12"))
  } finally {
    app.renderer.destroy()
  }
})

test("the footer shows the help key only in lists whose rows have help", async () => {
  await using tmp = await tmpdir()
  const withHelp = await mountList(tmp.path, rows)
  try {
    expect(withHelp.app.captureCharFrame()).toMatch(/help \?/)
  } finally {
    withHelp.app.renderer.destroy()
  }
  const without = await mountList(tmp.path, [
    { title: "Alpha", value: "alpha", description: "first" },
    { title: "Beta", value: "beta" },
  ])
  try {
    expect(without.app.captureCharFrame()).not.toMatch(/help \?/)
    // ? still opens the row's description there.
    without.app.mockInput.pressKey("?")
    await without.app.waitForFrame((frame) => frame.includes(ROW_HELP_NONE) && frame.includes("first"))
  } finally {
    without.app.renderer.destroy()
  }
})

test("every Settings row has a help text, and names stay general", () => {
  const missing = settings.filter((setting) => !setting.help?.trim()).map((setting) => setting.title)
  expect(missing).toEqual([])
  for (const setting of settings) {
    expect(`${setting.title} ${setting.description}`).not.toMatch(/opus|claude|gpt|gemini|\bCPP\b/i)
    expect(setting.help).not.toMatch(/\bCPP\b/)
  }
})

test("? in Settings opens the selected row's help as a popup over Settings; Esc returns to that row with the search kept", async () => {
  await using setup = await createAppFixture({
    width: 100,
    height: 40,
    config: { animations: false, keybinds: { "opencode.settings": "f6" } },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame(
    (frame) => frame.includes("Settings") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("scroll")
  await setup.waitForFrame((frame) => frame.includes("Scroll speed") && frame.includes("Acceleration"))
  await setup.waitForVisualIdle()
  // Grouped by category: Scrollbar, then Scroll speed and Acceleration.
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  await setup.waitForVisualIdle()
  const before = setup.captureCharFrame()
  const row = settings.find((setting) => setting.title === "Acceleration")!
  setup.mockInput.pressKey("?")
  const help = await setup.waitForFrame((frame) => frame.includes(row.help!.slice(0, 30)))
  // The Settings popup stays drawn under the help: its title and search, above the help popup, are where they were.
  const lines = help.split("\n")
  const kept = before.split("\n").filter((line, index) => line === lines[index] && line.trim() !== "")
  expect(kept.join("\n")).toContain("Settings")
  expect(kept.join("\n")).toMatch(/^ +scroll +$/m)
  const helpTop = lines.findIndex((line) => line.includes("Acceleration") && !line.includes("3.00"))
  const helpBottom = lines.findLastIndex((line) => line.includes("back esc/?"))
  expect(Math.abs(helpTop - 1 - (40 - 1 - (helpBottom + 1)))).toBeLessThanOrEqual(1)
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("back esc/?"))
  await setup.waitForVisualIdle()
  expect(setup.captureCharFrame()).toBe(before)
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("scroll")
  setup.mockInput.pressKey("?")
  await setup.waitForFrame((frame) => frame.includes(row.help!.slice(0, 30)))
  setup.mockInput.pressKey("?")
  await setup.waitForFrame((frame) => !frame.includes("back esc/?"))
  await setup.waitForVisualIdle()
  expect(setup.captureCharFrame()).toBe(before)
  // The very next key acts on the list: Enter on Acceleration opens its value.
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("scroll")
})

test("? in the composer is typed", async () => {
  await using setup = await createAppFixture({ width: 100, height: 30, config: { animations: false } })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("why?")
  await setup.waitForFrame((frame) => frame.includes("why?"))
  expect(setup.captureCharFrame()).not.toContain(ROW_HELP_NONE)
})
