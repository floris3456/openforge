/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
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

// Spec row-help: `?` on the selected row of a list opens its help in the dialog's place; Esc or `?` again returns to
// the same row with the search as it was. A row without help shows its description and says there is nothing more.
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

test("? opens the selected row's help in the list's place and is not typed into the search", async () => {
  await using tmp = await tmpdir()
  const { app } = await mountList(tmp.path, rows)
  try {
    app.mockInput.pressKey("?")
    const frame = await app.waitForFrame((frame) => frame.includes("Alpha does the first thing"))
    expect(frame).not.toContain("Things")
    expect(frame).not.toContain("Beta")
    expect(frame).toContain("Alpha")
    expect(app.renderer.currentFocusedEditor).toBeNull()
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Things") && frame.includes("Beta"))
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    expect((app.renderer.currentFocusedEditor as InputRenderable).value).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("Esc and ? both return to the same row with the search and scroll as they were; the dialog stays open", async () => {
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
      app.mockInput.pressKey("?")
      await app.waitForFrame((frame) => !frame.includes("Things"))
      if (back === "escape") app.mockInput.pressEscape()
      else app.mockInput.pressKey("?")
      await app.waitForFrame((frame) => frame.includes("Things"))
      await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
      await app.waitForVisualIdle()
      expect(app.captureCharFrame()).toBe(before)
      expect(app.renderer.currentFocusedEditor?.plainText).toBe("row 1")
    }
    // Back on the same row: Enter picks the row the help was opened on.
    app.mockInput.pressKey("?")
    const help = await app.waitForFrame((frame) => !frame.includes("Things"))
    const title = help.match(/Row \d+/)![0]
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Things"))
    app.mockInput.pressEnter()
    await app.waitFor(() => selected.length === 1)
    expect(selected).toEqual([`row-${title.split(" ")[1]}`])
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

test("a long help wraps inside the dialog and scrolls", async () => {
  await using tmp = await tmpdir()
  const { app } = await mountList(tmp.path, rows, 50, 24)
  try {
    app.mockInput.pressKey("END")
    app.mockInput.pressKey("?")
    const frame = await app.waitForFrame((frame) => frame.includes("Paragraph 1 "))
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

test("? in Settings opens the selected row's help in the dialog's place; Esc returns to that row with the search kept", async () => {
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
  expect(help).not.toContain("Settings")
  expect(help).not.toContain("Scrollbar")
  expect(help).not.toContain("3.00")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("Settings"))
  await setup.waitForVisualIdle()
  expect(setup.captureCharFrame()).toBe(before)
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("scroll")
  setup.mockInput.pressKey("?")
  await setup.waitForFrame((frame) => frame.includes(row.help!.slice(0, 30)))
  setup.mockInput.pressKey("?")
  await setup.waitForFrame((frame) => frame.includes("Settings"))
  await setup.waitForVisualIdle()
  expect(setup.captureCharFrame()).toBe(before)
})

test("? in the composer is typed", async () => {
  await using setup = await createAppFixture({ width: 100, height: 30, config: { animations: false } })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("why?")
  await setup.waitForFrame((frame) => frame.includes("why?"))
  expect(setup.captureCharFrame()).not.toContain(ROW_HELP_NONE)
})
