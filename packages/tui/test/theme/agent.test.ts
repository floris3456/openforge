import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { parseThemeDocument, resolveThemeDocument, rgbToOklch } from "@opencode/theme/tui"
import { allThemes, parseTheme } from "../../src/theme"
import { agentHue, agentSettings, agentTheme } from "../../src/theme/agent"
import { hex } from "../../src/theme/custom"
import type { AgentThemePart } from "../../src/config"

// openforge (spec agent-theme): the agent theme is a base theme whose chosen parts take the agent's hue at their own
// lightness; everything else, and status, diff and code colours always, stays the base theme's exactly.

const all: AgentThemePart[] = ["background", "panels", "borders", "accents", "headings", "text"]

function colours(theme: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(theme).flatMap(([key, value]): [string, string][] => {
      if (key === "hue" || key === "categorical" || typeof value === "function") return []
      if (value instanceof RGBA) return [[`${prefix}${key}`, hex(value)]]
      if (value && typeof value === "object") return Object.entries(colours(value, `${prefix}${key}.`))
      return []
    }),
  )
}

function agent(name: string, follow: AgentThemePart[], hue = 150, strength: "subtle" | "clear" | "strong" = "clear") {
  const base = parseTheme(allThemes()[name]!, name)
  return { base, theme: parseThemeDocument(agentTheme(base, hue, { follow, strength }), "agent") }
}

const oklch = (color: RGBA) => rgbToOklch(color.r, color.g, color.b)

describe("agent theme", () => {
  test("a chat's hue is one of the badge palette's 24, the same for the same chat, and spread over all of them", () => {
    expect(agentHue("ses_alpha")).toBe(agentHue("ses_alpha"))
    const hues = Array.from({ length: 400 }, (_, index) => agentHue(`ses_${index.toString(36)}x${index * 7919}`))
    expect(hues.every((hue) => hue % 15 === 0 && hue >= 0 && hue < 360)).toBeTrue()
    expect(new Set(hues).size).toBe(24)
  })

  test("settings default to opencode with the background and panels, clear; the agent theme can't be its own base", () => {
    expect(agentSettings(undefined)).toEqual({ base: "opencode", follow: ["background", "panels"], strength: "clear" })
    expect(agentSettings({ base: "agent", follow: [], strength: "strong" })).toEqual({
      base: "opencode",
      follow: [],
      strength: "strong",
    })
  })

  test.each(["opencode", "dracula", "github", "nord"])(
    "%s: only the background follows, in the agent's hue at its own lightness, and nothing else of the screen changes",
    (name) => {
      const { base, theme } = agent(name, ["background"])
      for (const mode of ["dark", "light"] as const) {
        const before = resolveThemeDocument(base, mode)
        const after = resolveThemeDocument(theme, mode)
        const was = oklch(before.background.base)
        const now = oklch(after.background.base)
        expect(Math.abs(now.h - 150)).toBeLessThan(4)
        expect(now.c).toBeGreaterThan(0.02)
        expect(Math.abs(now.l - was.l)).toBeLessThan(0.04)
        const a = colours(before)
        const b = colours(after)
        const changed = Object.keys(a).filter((key) => a[key] !== b[key])
        // The background, the fields and feedback drawn on it, and text drawn in its colour on a highlighted row.
        expect(changed.filter((key) => !/^background\.(base|formfield|feedback)|^text\.action\./.test(key))).toEqual([])
        for (const key of changed.filter((key) => key.startsWith("text.action.")))
          expect(b[key]).toBe(hex(after.background.base))
        expect(after.text.base.equals(before.text.base)).toBeTrue()
        expect(after.background.raised.base.equals(before.background.raised.base)).toBeTrue()
      }
    },
  )

  test.each(["opencode", "dracula", "solarized"])(
    "%s: with every part following, status, diff and code colours stay the base theme's, on the screen and in dialogs",
    (name) => {
      const { base, theme } = agent(name, all)
      for (const mode of ["dark", "light"] as const) {
        for (const surface of [undefined, "dialog", "dialog.footer"] as const) {
          const before = surface ? resolveThemeDocument(base, mode).surface(surface) : resolveThemeDocument(base, mode)
          const after = surface ? resolveThemeDocument(theme, mode).surface(surface) : resolveThemeDocument(theme, mode)
          const a = colours(before)
          const b = colours(after)
          const locked = Object.keys(a).filter((key) => /^(syntax|diff)\.|^text\.feedback\./.test(key))
          expect(locked.length).toBeGreaterThan(20)
          expect(locked.filter((key) => a[key] !== b[key])).toEqual([])
          for (const color of [after.background.base, after.background.raised.base, after.border.base, after.text.base])
            expect(Math.abs(oklch(color).h - 150)).toBeLessThan(6)
          expect(Math.abs(oklch(after.markdown.heading).h - 150)).toBeLessThan(6)
          expect(Math.abs(oklch(after.text.formfield.focused).h - 150)).toBeLessThan(6)
        }
      }
    },
  )

  test("a recoloured panel still steps up and down its scale, as the prompt and hovered rows use", () => {
    const { theme } = agent("opencode", ["background", "panels"])
    const resolved = resolveThemeDocument(theme, "dark")
    const stepped = resolved.decrease(resolved.background.raised.base)
    expect(stepped.equals(resolved.background.raised.base)).toBeFalse()
    expect(Math.abs(oklch(stepped).h - 150)).toBeLessThan(6)
  })

  test("transparent colours stay transparent, and a stronger setting gives more colour", () => {
    const subtle = resolveThemeDocument(agent("opencode", all, 30, "subtle").theme, "dark")
    const strong = resolveThemeDocument(agent("opencode", all, 30, "strong").theme, "dark")
    expect(strong.background.action.primary.base.a).toBe(0)
    expect(oklch(strong.background.raised.base).c).toBeGreaterThan(oklch(subtle.background.raised.base).c)
    expect(oklch(strong.text.base).c).toBeGreaterThan(oklch(subtle.text.base).c)
  })

  test("two chats of different hues get different backgrounds; a theme with one mode keeps one mode", () => {
    const one = resolveThemeDocument(agent("dracula", ["background"], 30).theme, "dark")
    const two = resolveThemeDocument(agent("dracula", ["background"], 210).theme, "dark")
    expect(one.background.base.equals(two.background.base)).toBeFalse()
    const single = agentTheme(parseTheme(allThemes().vesper!, "vesper"), 30, { follow: all, strength: "clear" })
    expect(Object.keys(single).filter((key) => key === "dark" || key === "light")).toEqual(
      Object.keys(parseTheme(allThemes().vesper!, "vesper")).filter((key) => key === "dark" || key === "light"),
    )
  })
})
