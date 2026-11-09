import { describe, expect, test } from "bun:test"
import type { RGBA } from "@opentui/core"
import { migrateV1, parseThemeDocument, resolveThemeDocument, type ResolvedTheme } from "../src/tui/index.js"
import type { ThemeV1Json } from "../src/tui/v1.js"

const source: ThemeV1Json = await Bun.file(new URL("../../tui/src/theme/assets/opencode.json", import.meta.url)).json()
const document = migrateV1(source)
const opencode = await Bun.file(new URL("../../tui/src/theme/assets/v2/opencode.json", import.meta.url)).json()
const lucent: ThemeV1Json = await Bun.file(
  new URL("../../tui/src/theme/assets/lucent-orng.json", import.meta.url),
).json()

test.each(["light", "dark"] as const)("resolves %s themes without status tokens", (mode) => {
  const theme = resolveThemeDocument(document, mode)
  expect("status" in theme.text).toBeFalse()
  expect(theme.hue.accent[800]).toBeDefined()
  expect(theme.hue.interactive[800]).toBeDefined()
})

// Spec cliproxypacer-usage-meters, section 6.
describe("background.meter", () => {
  const hex = (color: RGBA) =>
    "#" +
    color
      .toInts()
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")
  const tones = (theme: ResolvedTheme) => {
    const meter = theme.background.meter
    const row = (set: Omit<typeof meter, "alternate">) => ({
      track: hex(set.track),
      success: hex(set.success),
      warning: hex(set.warning),
      error: hex(set.error),
      muted: hex(set.muted),
    })
    return { ...row(meter), alternate: row(meter.alternate) }
  }
  const resolve = (input: unknown, mode: "light" | "dark") => resolveThemeDocument(parseThemeDocument(input), mode)
  const dark = {
    track: "#1f1f1fff",
    success: "#38573eff",
    warning: "#614624ff",
    error: "#593235ff",
    muted: "#343434ff",
    alternate: {
      track: "#191919ff",
      success: "#304734ff",
      warning: "#4f3a20ff",
      error: "#492b2dff",
      muted: "#2d2d2dff",
    },
  }

  test("derives every tone of the opencode dark theme from its colors, mixed into background.raised.base", () => {
    const theme = resolve(opencode, "dark")
    expect(hex(theme.background.raised.base)).toBe("#141414ff")
    // The spec's numbers: a success fill of #38573e, alternate #304734, a track of #1f1f1f, alternate #191919.
    expect(tones(theme)).toEqual(dark)
  })

  test("derives the light tones by the same rule, the alternate row closer to the sidebar's background", () => {
    const theme = resolve(opencode, "light")
    expect(hex(theme.background.raised.base)).toBe("#fafafaff")
    expect(tones(theme)).toEqual({
      track: "#efefefff",
      success: "#bad9c3ff",
      warning: "#eed5b2ff",
      error: "#ecb8baff",
      muted: "#d8d8d8ff",
      alternate: {
        track: "#f4f4f4ff",
        success: "#c9e1d0ff",
        warning: "#f1ddc3ff",
        error: "#efc8c9ff",
        muted: "#e0e0e0ff",
      },
    })
  })

  test("derives them for a v1 theme, from its panel, text and feedback colors", () => {
    // The v1 opencode theme migrates to the same colors.
    expect(tones(resolveThemeDocument(document, "dark"))).toEqual(dark)
    const custom = migrateV1({
      defs: source.defs,
      theme: {
        ...source.theme,
        background: "#000000",
        backgroundPanel: "#101010",
        text: "#f0f0f0",
        textMuted: "#909090",
        success: "#50e050",
        warning: "#f0a030",
        error: "#e04040",
      },
    })
    expect(tones(resolveThemeDocument(custom, "dark"))).toEqual({
      track: "#1b1b1bff",
      success: "#265726ff",
      warning: "#5c411bff",
      error: "#572020ff",
      muted: "#363636ff",
      alternate: {
        track: "#161616ff",
        success: "#214621ff",
        warning: "#4a3518ff",
        error: "#461c1cff",
        muted: "#2d2d2dff",
      },
    })
  })

  test("keeps the tones a custom theme sets and derives the others", () => {
    const theme = resolve(
      {
        ...opencode,
        base: {
          ...opencode.base,
          background: {
            ...opencode.base.background,
            meter: { success: "#00ff00", alternate: { track: "$hue.neutral.600", error: "$text.feedback.error.base" } },
          },
        },
      },
      "dark",
    )
    expect(tones(theme)).toEqual({
      ...dark,
      success: "#00ff00ff",
      alternate: { ...dark.alternate, track: "#1e1e1eff", error: "#e06c75ff" },
    })
  })

  test("resolves on each view, from the view's own surface", () => {
    const theme = resolve(
      {
        ...opencode,
        base: { ...opencode.base, "@dialog": { background: { raised: { base: "#282828" } } } },
      },
      "dark",
    )
    expect(hex(theme.background.meter.track)).toBe("#1f1f1fff")
    expect(hex(theme.surface("dialog").background.meter.track)).toBe("#323232ff")
    expect(hex(theme.surface("dialog.footer").background.meter.track)).toBe("#323232ff")
  })

  test("mixes into background.base, made opaque, where background.raised.base is see-through", () => {
    const raised = (base: string, background = "#202020") =>
      resolve(
        {
          ...opencode,
          base: {
            ...opencode.base,
            background: { ...opencode.base.background, base: background, raised: { base, high: base, max: base } },
          },
        },
        "dark",
      )
    expect(hex(raised("transparent").background.meter.track)).toBe("#2a2a2aff")
    expect(hex(raised("transparent", "#20202000").background.meter.track)).toBe("#0c0c0cff")
    // A translucent surface counts as its own color.
    expect(hex(raised("#20202080", "#000000").background.meter.track)).toBe("#2a2a2aff")
  })

  test("mixes into black under light text and white under dark text where both backgrounds are transparent", () => {
    const night = resolveThemeDocument(migrateV1(lucent), "dark")
    expect(night.background.raised.base.a).toBe(0)
    expect(night.background.base.a).toBe(0)
    expect(hex(night.background.meter.track)).toBe("#0c0c0cff")
    expect(hex(night.background.meter.success)).toBe("#24374eff")
    const day = resolveThemeDocument(migrateV1(lucent), "light")
    expect(day.background.raised.base.a).toBe(0)
    expect(hex(day.background.meter.track)).toBe("#f4f4f4ff")
    expect(hex(day.background.meter.alternate.track)).toBe("#f9f9f9ff")
    // Every tone is opaque, so the terminal draws what was mixed.
    for (const theme of [night, day]) {
      const meter = theme.background.meter
      const all = [meter, meter.alternate].flatMap((set) => [set.track, set.success, set.warning, set.error, set.muted])
      expect(all.every((color) => color.a === 1)).toBeTrue()
    }
  })
})
