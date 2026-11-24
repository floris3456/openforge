import { expect, test } from "bun:test"
import { resolveThemeDocument, themeModes } from "@opencode/theme/tui"
import path from "node:path"
import { importScheme } from "../../src/theme/import"
import { allThemes, parseTheme } from "../../src/theme"
import { roleColor } from "../../src/theme/custom"

// openforge (spec custom-themes): each format the popular scheme sites hand out reads into a theme with the scheme's
// own colours in their usual roles. The files are the sites' own (tinted-theming, iTerm2-Color-Schemes, Gogh), apart
// from Alacritty's older YAML and terminal.sexy's JSON, written from the same Dracula colours.

const scheme = (file: string) => Bun.file(path.join(import.meta.dir, "schemes", file)).text()

// Dracula's terminal colours: background, text, red, green, yellow, blue, magenta, cyan.
const dracula = {
  background: "#282a36",
  text: "#f8f8f2",
  error: "#ff5555",
  success: "#50fa7b",
  warning: "#f1fa8c",
  primary: "#bd93f9",
  secondary: "#ff79c6",
  accent: "#8be9fd",
  textMuted: "#6272a4",
} as const

test.each([
  ["Dracula.itermcolors", "iTerm2"],
  ["Dracula.windowsterminal.json", "Windows Terminal"],
  ["Dracula.ghostty", "Ghostty"],
  ["Dracula.kitty.conf", "kitty"],
  ["Dracula.alacritty.toml", "Alacritty"],
  ["dracula.alacritty.yml", "Alacritty"],
  ["Dracula.Xresources", "Xresources"],
  ["Dracula.gogh.yml", "Gogh"],
  ["dracula.terminal-sexy.json", "terminal.sexy"],
])("a terminal scheme from %s (%s) takes its colours in their usual roles", async (file, format) => {
  const imported = importScheme(await scheme(file))
  expect(imported.format).toBe(format)
  // iTerm2 keeps four decimals of each channel, so its colours may be one step off.
  const close = (actual: string | undefined, expected: string) =>
    [1, 3, 5].every((at) => Math.abs(parseInt(actual!.slice(at, at + 2), 16) - parseInt(expected.slice(at, at + 2), 16)) <= 1)
  for (const [key, value] of Object.entries(dracula))
    expect(close(roleColor(imported.theme, key as keyof typeof dracula, "dark"), value)).toBeTrue()
  const document = parseTheme(imported.theme, "imported")
  expect(themeModes(document)).toEqual(["dark"])
  expect(resolveThemeDocument(document, "dark").text.base.toInts().slice(0, 3)).toEqual([248, 248, 242])
})

test("base16 YAML takes each colour's role from tinted-theming's styling guide, and carries the scheme's name", async () => {
  const imported = importScheme(await scheme("gruvbox-dark-hard.base16.yaml"))
  expect(imported).toMatchObject({ name: "Gruvbox dark, hard", format: "base16" })
  const color = (key: Parameters<typeof roleColor>[1]) => roleColor(imported.theme, key, "dark")
  expect(color("background")).toBe("#1d2021")
  expect(color("backgroundPanel")).toBe("#3c3836")
  expect(color("text")).toBe("#d5c4a1")
  expect(color("syntaxComment")).toBe("#665c54")
  expect(color("error")).toBe("#fb4934")
  expect(color("syntaxNumber")).toBe("#fe8019")
  expect(color("primary")).toBe("#83a598")
  expect(color("syntaxKeyword")).toBe("#d3869b")
})

test("base24 YAML uses its bright colours for the changed words of a diff", async () => {
  const imported = importScheme(await scheme("dracula.base24.yaml"))
  expect(imported).toMatchObject({ name: "Dracula", format: "base24" })
  expect(roleColor(imported.theme, "diffHighlightRemoved", "dark")).toBe("#ff6e6e")
  expect(roleColor(imported.theme, "diffHighlightAdded", "dark")).toBe("#69ff94")
})

test("a light scheme reads as a light theme", async () => {
  const imported = importScheme(await scheme("solarized-light.base16.yaml"))
  expect(themeModes(parseTheme(imported.theme, "imported"))).toEqual(["light"])
  expect(roleColor(imported.theme, "background", "light")).toBe("#fdf6e3")
})

test("an opencode theme of either format reads as it is", () => {
  const classic = importScheme(JSON.stringify(allThemes().gruvbox))
  expect(classic.format).toBe("opencode")
  expect(classic.theme).toEqual(allThemes().gruvbox as never)
  const newer = importScheme(JSON.stringify(allThemes().opencode))
  expect(newer.format).toBe("opencode")
  expect(roleColor(newer.theme, "background", "dark")).toBe(
    `#${resolveThemeDocument(parseTheme(allThemes().opencode!, "opencode"), "dark")
      .background.base.toInts()
      .slice(0, 3)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`,
  )
})

test("text that is no colour scheme is refused with the formats that can be read", () => {
  expect(() => importScheme("just some words")).toThrow("isn't a colour scheme openforge can read")
  expect(() => importScheme('{"name": "half", "black": "#000000"}')).toThrow("base16 or base24 YAML")
})
