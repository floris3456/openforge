import { beforeEach, expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { resolveThemeDocument } from "@opencode/theme/tui"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import { parseTheme } from "../src/theme"
import type { ThemeV1Json } from "@opencode/theme/tui/v1"

// openforge (spec custom-themes): a built-in copied into a named theme of your own, one colour set where it is used,
// a scheme imported by pasting it; each a file in the global themes folder, previewed while edited.

// The home screen's draft is kept in the process across apps; one an earlier test file left would be typed before
// the commands here.
beforeEach(() => takeDraft(undefined))

type Setup = Awaited<ReturnType<typeof createAppFixture>>

const dialogSurface = (source: object, name: string) =>
  resolveThemeDocument(parseTheme(source as never, name), "dark").surface("dialog").background.base

/** The background of the open dialog, read beside its "esc". */
function dialogBackground(setup: Setup) {
  const header = setup.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("esc")))
  return header?.spans.find((span) => span.text.includes("esc"))?.bg
}

async function command(setup: Setup, slash: string, shows: string) {
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.renderer.stdin.emit("data", Buffer.from(`/${slash}\r`))
  await setup.waitForFrame((frame) => frame.includes(shows) && focused(setup))
}

const focused = (setup: Setup) =>
  setup.renderer.currentFocusedRenderable instanceof InputRenderable ||
  setup.renderer.currentFocusedRenderable instanceof TextareaRenderable

function themeFile(setup: Setup, name: string) {
  return Bun.file(path.join(setup.configDirectory, "themes", `${name}.json`)).json() as Promise<ThemeV1Json>
}

test("a built-in copied under a name, one colour set and previewed, listed as yours", async () => {
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { mode: "off" }, theme: { name: "nord", mode: "dark" } },
  })
  await setup.ready
  await command(setup, "customize-themes", "Import a colour scheme")
  expect(setup.captureCharFrame()).toContain("Import a colour scheme")
  await setup.mockInput.typeText("dracula")
  await setup.waitForFrame((frame) => frame.includes("Copy into a theme of your own"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Copy dracula") && focused(setup))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Edit dracula copy"))
  const copy = await themeFile(setup, "dracula copy")
  expect(copy.theme.background).toEqual({ dark: "#282a36", light: "#f8f8f2" })
  await setup.waitForFrame(() => dialogBackground(setup)?.equals(dialogSurface(copy, "copy")) === true)

  await setup.waitForFrame(() => focused(setup))
  await setup.mockInput.typeText("Background")
  await setup.waitForFrame((frame) => frame.includes("#282a36"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Background (dark)") && focused(setup))
  for (const _ of "#282a36") setup.mockInput.pressBackspace()
  await setup.mockInput.typeText("#102030")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Edit dracula copy") && frame.includes("#102030"))
  const edited = await themeFile(setup, "dracula copy")
  expect(edited.theme.background).toEqual({ dark: "#102030", light: "#f8f8f2" })
  expect(edited.theme.primary).toBe(copy.theme.primary)
  await setup.waitForFrame(() => dialogBackground(setup)?.equals(dialogSurface(edited, "edited")) === true)
  expect(setup.config().theme).toEqual({ name: "nord", mode: "dark" })

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("Your themes") && frame.includes("dracula copy"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Customize themes"))

  await command(setup, "themes", "Global theme (")
  await setup.mockInput.typeText("dracula copy")
  await setup.waitForFrame((frame) => /dracula copy\s+custom/.test(frame))
  setup.mockInput.pressEnter()
  // The fixture's folder is a project: the theme is set for it.
  await setup.waitFor(() => setup.config().projects?.proj_test?.theme?.name === "dracula copy")
})

const gruvbox = `system: "base16"
name: "Gruvbox dark, hard"
palette:
  base00: "#1d2021"
  base01: "#3c3836"
  base02: "#504945"
  base03: "#665c54"
  base04: "#bdae93"
  base05: "#d5c4a1"
  base06: "#ebdbb2"
  base07: "#fbf1c7"
  base08: "#fb4934"
  base09: "#fe8019"
  base0A: "#fabd2f"
  base0B: "#b8bb26"
  base0C: "#8ec07c"
  base0D: "#83a598"
  base0E: "#d3869b"
  base0F: "#d65d0e"
`

test("a pasted base16 scheme becomes a theme of its name, and a theme of yours can be renamed and deleted", async () => {
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { mode: "off" }, theme: { name: "nord", mode: "dark" } },
  })
  await setup.ready
  await command(setup, "customize-themes", "Import a colour scheme")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Import a colour scheme") && frame.includes("base16") && focused(setup))
  await setup.mockInput.pasteBracketedText(gruvbox)
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Name the base16 scheme") && focused(setup))
  expect(setup.captureCharFrame()).toContain("Gruvbox dark hard")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Edit Gruvbox dark hard") && focused(setup))
  const imported = await themeFile(setup, "Gruvbox dark hard")
  expect(imported.theme.background).toBe("#1d2021")
  expect(imported.theme.syntaxKeyword).toBe("#d3869b")

  // Use it here (the fixture's folder is a project), then rename it: the project's theme follows the new name.
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.config().projects?.proj_test?.theme?.name === "Gruvbox dark hard")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Rename Gruvbox dark hard") && focused(setup))
  for (const _ of " dark hard") setup.mockInput.pressBackspace()
  await setup.mockInput.typeText(" mine")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Edit Gruvbox mine") && focused(setup))
  expect(setup.config().projects?.proj_test?.theme?.name).toBe("Gruvbox mine")
  expect(await readdir(path.join(setup.configDirectory, "themes"))).toEqual(["Gruvbox mine.json"])

  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Delete Gruvbox mine?"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Customize themes") && !frame.includes("Your themes"))
  expect(await readdir(path.join(setup.configDirectory, "themes"))).toEqual([])
})

test("a name a theme already has is refused, and so is text that is no scheme", async () => {
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { mode: "off" } },
  })
  await setup.ready
  await command(setup, "customize-themes", "Import a colour scheme")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Import a colour scheme") && focused(setup))
  await setup.mockInput.typeText("not a scheme")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("isn't a colour scheme openforge can read"))

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("Customize themes") && focused(setup))
  await setup.mockInput.typeText("aura")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Copy aura") && focused(setup))
  for (const _ of " copy") setup.mockInput.pressBackspace()
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("There is already a theme called aura"))
})
