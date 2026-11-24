import { expect, test } from "bun:test"
import { resolveThemeDocument, themeModes } from "@opencode/theme/tui"
import { allThemes, parseTheme } from "../../src/theme"
import path from "node:path"
import { copyTheme, hex, nameProblem, parseHex, roleColor, roles, setRole } from "../../src/theme/custom"
import { importScheme } from "../../src/theme/import"

// openforge (spec custom-themes): a copy of a theme looks as the theme does, with every role a colour of its own; one
// role changes for one mode at a time.

const resolved = (source: object, name: string, mode: "dark" | "light") =>
  resolveThemeDocument(parseTheme(source as never, name), mode)

test.each(["gruvbox", "catppuccin", "github", "dracula"])("a copy of %s draws exactly as the theme does", (name) => {
  const source = allThemes()[name]!
  const copy = copyTheme(source, name)
  expect(themeModes(parseTheme(copy, "copy"))).toEqual(themeModes(parseTheme(source, name)))
  for (const mode of themeModes(parseTheme(source, name))) {
    const [original, copied] = [resolved(source, name, mode), resolved(copy, "copy", mode)]
    expect(hex(copied.background.base)).toBe(hex(original.background.base))
    expect(hex(copied.text.base)).toBe(hex(original.text.base))
    expect(hex(copied.text.muted)).toBe(hex(original.text.muted))
    expect(hex(copied.background.raised.base)).toBe(hex(original.background.raised.base))
    expect(hex(copied.syntax.keyword)).toBe(hex(original.syntax.keyword))
    expect(hex(copied.markdown.heading)).toBe(hex(original.markdown.heading))
  }
  // Every role is written as a colour, so editing one never depends on the original's named colours.
  for (const role of roles) expect(copy.theme[role.key]).toBeDefined()
  expect(copy.defs).toBeUndefined()
})

test("a copy of the default theme keeps its backgrounds, text, accents and code colours in both modes", () => {
  const source = allThemes().opencode!
  const copy = copyTheme(source, "opencode")
  expect(themeModes(parseTheme(copy, "copy"))).toEqual(["light", "dark"])
  for (const mode of ["dark", "light"] as const) {
    const [original, copied] = [resolved(source, "opencode", mode), resolved(copy, "copy", mode)]
    expect(hex(copied.background.base)).toBe(hex(original.background.base))
    expect(hex(copied.text.base)).toBe(hex(original.text.base))
    expect(hex(copied.text.feedback.error.base)).toBe(hex(original.text.feedback.error.base))
    expect(hex(copied.syntax.string)).toBe(hex(original.syntax.string))
    expect(hex(copied.diff.text.added)).toBe(hex(original.diff.text.added))
  }
})

test("setting a role changes it in one mode only, and the theme still reads", async () => {
  const copy = copyTheme(allThemes().opencode!, "opencode")
  const light = roleColor(copy, "background", "light")
  const changed = setRole(copy, "background", "dark", "#102030")
  expect(roleColor(changed, "background", "dark")).toBe("#102030")
  expect(roleColor(changed, "background", "light")).toBe(light)
  expect(hex(resolved(changed, "changed", "dark").background.base)).toBe("#102030")

  // A theme of one mode keeps one colour per role.
  const single = importScheme(await Bun.file(path.join(import.meta.dir, "schemes", "Dracula.kitty.conf")).text()).theme
  const one = setRole(single, "primary", "dark", "#abcdef")
  expect(one.theme.primary).toBe("#abcdef")
})

test("a name must be new, short and plain", () => {
  const taken = (name: string) => ["opencode", "system", "mine"].includes(name)
  expect(nameProblem("My theme", taken)).toBeUndefined()
  expect(nameProblem("dracula-2.dim", taken)).toBeUndefined()
  expect(nameProblem("", taken)).toBe("Give the theme a name")
  expect(nameProblem(" padded", taken)).toBe("A name can't start or end with a space")
  expect(nameProblem("a/b", taken)).toBe("Use letters, digits, spaces, dots, dashes and underscores")
  expect(nameProblem(".hidden", taken)).toBe("Use letters, digits, spaces, dots, dashes and underscores")
  expect(nameProblem("x".repeat(41), taken)).toBe("Use at most 40 characters")
  expect(nameProblem("mine", taken)).toBe("There is already a theme called mine")
})

test("a colour typed by hand", () => {
  expect(parseHex("#ABC")).toBe("#aabbcc")
  expect(parseHex("102030")).toBe("#102030")
  expect(parseHex(" #10203040 ")).toBe("#10203040")
  expect(parseHex("red")).toBeUndefined()
  expect(parseHex("#12345")).toBeUndefined()
})
