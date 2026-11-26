import { RGBA } from "@opentui/core"
import { oklchToHex, rgbToOklch } from "@opencode/theme/tui"

// openforge (the workspace's spec docs/specs/agent-badges.md, section 3, item 3): a colour that isn't the theme's, a
// chat's agent's, drawn as text on the theme's surfaces. It is lightened or darkened in OKLCH, keeping its hue, until
// it reaches WCAG's 4.5:1 against what it is drawn on; its chroma gives way only where sRGB has none at that lightness.

/** WCAG 2's least contrast for text. */
export const READABLE = 4.5

/** Answers by colour and background: a tab's title asks once per cell and frame. */
const answers = new Map<string, RGBA>()
const ANSWERS = 512

/** `color` as text on `background`: itself when it reaches `ratio`, else the lightness nearest its own that does. */
export function readable(color: RGBA, background: RGBA, ratio = READABLE): RGBA {
  const key = `${color.toInts().join()}|${background.toInts().join()}|${ratio}`
  const known = answers.get(key)
  if (known) return known
  const answer = contrast(color, background) >= ratio ? color : moved(color, background, ratio)
  answers.set(key, answer)
  if (answers.size > ANSWERS) answers.delete(answers.keys().next().value!)
  return answer
}

/** WCAG 2's contrast ratio of two colours, 1 to 21. */
export function contrast(one: RGBA, two: RGBA) {
  const [high, low] = [luminance(one), luminance(two)].sort((a, b) => b - a)
  return (high! + 0.05) / (low! + 0.05)
}

function luminance(color: RGBA) {
  const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/**
 * Lighter when the background is darker than the colour, darker when it is lighter; the other way when that way can't
 * reach `ratio`. Where neither can, on a background of middle lightness, the end with the most contrast.
 */
function moved(color: RGBA, background: RGBA, ratio: number) {
  const own = rgbToOklch(color.r, color.g, color.b)
  const at = (l: number) => RGBA.fromHex(oklchToHex({ l, c: own.c, h: own.h }))
  const first = luminance(background) < luminance(color)
  const found = search(own.l, first, at, background, ratio) ?? search(own.l, !first, at, background, ratio)
  if (found) return found
  const [light, dark] = [at(1), at(0)]
  return contrast(light, background) >= contrast(dark, background) ? light : dark
}

/** The lightness nearest `from`, toward white (`up`) or black, whose colour reaches `ratio`; none when the end doesn't. */
function search(from: number, up: boolean, at: (l: number) => RGBA, background: RGBA, ratio: number) {
  const end = up ? 1 : 0
  if (contrast(at(end), background) < ratio) return undefined
  // Contrast grows toward the end: halve the stretch between a lightness that falls short and one that reaches.
  const [, reaches] = Array.from({ length: 20 }).reduce<[number, number]>(
    ([short, reaches]) => {
      const middle = (short + reaches) / 2
      return contrast(at(middle), background) >= ratio ? [short, middle] : [middle, reaches]
    },
    [from, end],
  )
  return at(reaches)
}
