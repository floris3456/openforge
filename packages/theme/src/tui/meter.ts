import { RGBA } from "@opentui/core"
import { MeterTone } from "./schema.js"
import type { MeterTones, ResolvedThemeTokens } from "./types.js"

/**
 * How much of each tone's ink a tone the theme doesn't set holds, mixed into the meters' surface, on a row and on the
 * alternate row (spec cliproxypacer-usage-meters, section 6): so the alternate row is closer to the surface in light
 * and dark themes alike.
 */
const MIX = {
  track: [0.05, 0.025],
  success: [0.34, 0.26],
  warning: [0.34, 0.26],
  error: [0.34, 0.26],
  muted: [0.3, 0.23],
} as const satisfies Record<MeterTone, readonly [number, number]>

type Set = Partial<MeterTones> & { readonly alternate?: Partial<MeterTones> }

/**
 * `background.meter` of a view: the tones the theme sets, as it sets them; the others mixed from its own colors into
 * the surface the meters sit on, `background.raised.base` (the sidebar's): the feedback text colors for the fills, the
 * muted text for a reading that isn't current, the base text for the track.
 */
export function meterTones(
  text: Pick<ResolvedThemeTokens["text"], "base" | "muted" | "feedback">,
  background: Pick<ResolvedThemeTokens["background"], "base" | "raised"> & { readonly meter?: Set },
): ResolvedThemeTokens["background"]["meter"] {
  const under = surface(text, background)
  const ink: Record<MeterTone, RGBA> = {
    track: text.base,
    success: text.feedback.success.base,
    warning: text.feedback.warning.base,
    error: text.feedback.error.base,
    muted: text.muted,
  }
  const tones = (set: Partial<MeterTones> | undefined, row: 0 | 1) =>
    Object.fromEntries(
      MeterTone.literals.map((tone) => [tone, set?.[tone] ?? mix(under, ink[tone], MIX[tone][row])]),
    ) as MeterTones
  return { ...tones(background.meter, 0), alternate: tones(background.meter?.alternate, 1) }
}

/**
 * What the tones are mixed into: `background.raised.base`, made opaque. Where a theme leaves it fully transparent, the
 * terminal's own background shows, which a theme can't know: then `background.base`, made opaque; with both fully
 * transparent, black under light text and white under dark text, as the v1 migration's dialog background falls back.
 */
function surface(
  text: Pick<ResolvedThemeTokens["text"], "base">,
  background: Pick<ResolvedThemeTokens["background"], "base" | "raised">,
) {
  const visible = [background.raised.base, background.base].find((color) => color.a > 0)
  if (visible) return RGBA.fromValues(visible.r, visible.g, visible.b, 1)
  return 0.299 * text.base.r + 0.587 * text.base.g + 0.114 * text.base.b > 0.5
    ? RGBA.fromInts(0, 0, 0)
    : RGBA.fromInts(255, 255, 255)
}

/** `amount` of `ink` over `under`, in sRGB, opaque. */
function mix(under: RGBA, ink: RGBA, amount: number) {
  const channel = (from: number, to: number) => Math.round((from + (to - from) * amount) * 255)
  return RGBA.fromInts(channel(under.r, ink.r), channel(under.g, ink.g), channel(under.b, ink.b))
}
