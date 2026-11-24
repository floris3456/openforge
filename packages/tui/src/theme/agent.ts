import { RGBA } from "@opentui/core"
import {
  expandTheme,
  HueStep,
  oklchToHex,
  resolveTheme,
  resolveThemeDocument,
  rgbToOklch,
  selectThemeMode,
  themeModes,
  type Mode,
  type ResolvedTheme,
  type ThemeDefinition,
  type ThemeDocument,
} from "@opencode/theme/tui"
import type { AgentTheme, AgentThemePart, AgentThemeStrength } from "../config"
import { hex } from "./custom"

// openforge (spec agent-theme): the theme named "agent" is a base theme whose chosen parts take the shown chat's agent
// colour: each colour of a part keeps its lightness and takes the agent's hue, so contrast stays the base theme's. The
// other parts, and status, diff and code colours always, stay the base theme's exactly.

export const AGENT_THEME = "agent"
export const AGENT_LABEL = "Agent colours"

/** The parts that can follow the agent, in the order the settings list them, with what each covers. */
export const agentParts: readonly { key: AgentThemePart; title: string; help: string }[] = [
  { key: "background", title: "Background", help: "Behind everything: the chat, the home screen, the tab strip" },
  { key: "panels", title: "Panels", help: "The prompt box, your messages, the sidebar, dialogs and raised rows" },
  { key: "borders", title: "Borders", help: "Borders of panels and boxes, and scrollbars" },
  { key: "accents", title: "Accents", help: "The highlighted row, the active tab, prompts and marks" },
  { key: "headings", title: "Headings and links", help: "Headings, links and link text in replies" },
  { key: "text", title: "Text", help: "Ordinary and muted text, a faint tint of the colour" },
]
export const agentStrengths: readonly AgentThemeStrength[] = ["subtle", "clear", "strong"]

export type AgentSettings = { base: string; follow: readonly AgentThemePart[]; strength: AgentThemeStrength }

export function agentSettings(config: AgentTheme | undefined): AgentSettings {
  return {
    base: config?.base && config.base !== AGENT_THEME ? config.base : "opencode",
    follow: config?.follow ?? ["background", "panels"],
    strength: config?.strength ?? "clear",
  }
}

/** The label a theme name shows with. */
export function themeLabel(name: string) {
  return name === AGENT_THEME ? AGENT_LABEL : name
}

/**
 * Interim, until CLIProxyPacer gives each chat's agent its colour scheme (spec agent-badges): one of that palette's 24
 * hues, every 15 degrees, picked by a hash (FNV-1a) of the root chat's id, so every window showing a chat agrees on it.
 */
export function agentHue(chat: string) {
  const hash = Array.from(chat).reduce(
    (value, char) => Math.imul(value ^ char.charCodeAt(0), 0x01000193) >>> 0,
    0x811c9dc5,
  )
  return (hash % 24) * 15
}

/** The hue shown while the agent theme is previewed with no chat on screen. */
export const AGENT_SAMPLE_HUE = 285

/** The base theme with the followed parts in the agent's hue, in every mode the base theme has. */
export function agentTheme(base: ThemeDocument, hue: number, settings: Omit<AgentSettings, "base">): ThemeDocument {
  const modes = themeModes(base)
  const [first, second] = modes.map((mode) => recolour(base, mode, hue, settings))
  const { hue: hues, ...tokens } = first!
  const document: Record<string, unknown> = { base: tokens, [modes[0]!]: { hue: hues } }
  if (!second) return document as unknown as ThemeDocument
  // The second mode is layered on the first's colours: where the first sets a colour the second doesn't, the second
  // sets what it shows on its own.
  const own = surfaces(resolveTheme(second))
  document[modes[1]!] = second
  settle(
    () => resolveThemeDocument(document as unknown as ThemeDocument, modes[1]),
    second as Record<string, unknown>,
    targets([first as Record<string, unknown>, second as Record<string, unknown>], own, (_, __, was) => hex(was)),
  )
  return document as unknown as ThemeDocument
}

// Lightness is kept; chroma per part and strength, at least the colour's own for parts that are colours already.
const chroma: Record<AgentThemePart, readonly [number, number, number]> = {
  background: [0.02, 0.04, 0.065],
  panels: [0.02, 0.035, 0.055],
  borders: [0.04, 0.07, 0.1],
  text: [0.015, 0.03, 0.05],
  headings: [0.08, 0.11, 0.14],
  accents: [0.08, 0.11, 0.14],
}

function recolour(document: ThemeDocument, mode: Mode, hue: number, settings: Omit<AgentSettings, "base">) {
  const follows = new Set(settings.follow)
  const level = Math.max(0, agentStrengths.indexOf(settings.strength))
  const original = resolveThemeDocument(document, mode)
  const definition = expandTheme(selectThemeMode(document, mode).theme)
  const tint = (part: AgentThemePart | undefined, color: RGBA, opaque = false) => {
    if (!part || !follows.has(part) || (color.a === 0 && !opaque)) return color
    const own = rgbToOklch(color.r, color.g, color.b)
    const target = chroma[part][level]!
    const c = part === "headings" || part === "accents" ? Math.max(own.c, target) : target
    // Pure white or black hold no colour: surfaces that near them are drawn a little further in, in the same order.
    const surface = part === "background" || part === "panels" || part === "borders"
    const l = !surface ? own.l : own.l > 0.94 ? 0.94 + (own.l - 0.94) / 2 : own.l < 0.16 ? 0.08 + own.l / 2 : own.l
    const result = RGBA.fromHex(oklchToHex({ l, c, h: hue }))
    return color.a > 0 && color.a < 1 ? RGBA.fromValues(result.r, result.g, result.b, color.a) : result
  }

  // The neutral scale's steps are the background (800, 900), the panels (500 to 700) and the text (100 to 400); the
  // accent scales are the accents. Recolouring the scales keeps the references to them, so stepping a colour up or
  // down the scale (prompt and hover backgrounds) stays in the agent's hue.
  const scale = (name: string, part: (step: HueStep) => AgentThemePart) =>
    Object.fromEntries(
      HueStep.literals.map((step) => [step, hex(tint(part(step), original.hue[name as "neutral"][step]))]),
    )
  const hues = {
    ...definition.hue,
    ...(["background", "panels", "text"].some((part) => follows.has(part as AgentThemePart))
      ? { neutral: scale("neutral", neutralPart) }
      : {}),
    ...(follows.has("accents")
      ? { interactive: scale("interactive", () => "accents"), accent: scale("accent", () => "accents") }
      : {}),
  }
  const next = structuredClone({ ...definition, hue: hues }) as Record<string, unknown>

  // Every colour of the screen, of a dialog and of a dialog's footer gets a target: its part's tint of what it showed.
  // Status, diff and code colours that named a recoloured colour thus keep what they showed.
  const shown = surfaces(original)
  settle(
    () => resolveTheme(next as ThemeDefinition),
    next,
    targets([next], shown, (index, path, was) => {
      const part = partOf(path, value([next], index, path), index > 0, (target) => value([next], index, target))
      return hex(tint(part, was, path.join(".") === "background.base"))
    }),
  )
  return next as ThemeDefinition
}

type Target = { index: number; path: string[]; target: string }

const surfaces = (theme: ResolvedTheme) => [theme, theme.surface("dialog"), theme.surface("dialog.footer")]

// A definition's layers: the screen's colours, a dialog's over them and a dialog footer's over those.
function layers(definition: Record<string, unknown>) {
  const dialog = definition["@dialog"] as Record<string, unknown> | undefined
  return [definition, dialog, dialog?.["@footer"] as Record<string, unknown> | undefined]
}

// The value a colour has on a layer: the nearest layer's that sets it.
function value(definitions: Record<string, unknown>[], index: number, path: string[]) {
  return definitions
    .flatMap((definition) => layers(definition).slice(0, index + 1))
    .reverse()
    .map((tokens) => (tokens ? read(tokens, path) : undefined))
    .find((item) => item !== undefined)
}

// A target for every colour any of the definitions sets, on each layer it shows on.
function targets(
  definitions: Record<string, unknown>[],
  shown: ResolvedTheme[],
  target: (index: number, path: string[], was: RGBA) => string,
): Target[] {
  return [0, 1, 2].flatMap((index) => {
    const paths = new Map(
      definitions
        .flatMap((definition) => layers(definition).slice(0, index + 1))
        .flatMap((tokens) => (tokens ? leaves(tokens) : []))
        .map((path) => [path.join("."), path]),
    )
    return [...paths.values()].flatMap((path) => {
      const was = read(shown[index], path)
      return was instanceof RGBA ? [{ index, path, target: target(index, path, was) }] : []
    })
  })
}

// A colour stays a reference while the reference gives its target, else it becomes the target itself, written on the
// layer it shows on, the screen's before a dialog's, until every colour gives its target.
function settle(resolve: () => ResolvedTheme, definition: Record<string, unknown>, wanted: Target[]) {
  for (const _ of Array.from({ length: 12 })) {
    const now = surfaces(resolve())
    const wrong = wanted.filter((item) => {
      const color = read(now[item.index], item.path)
      return !(color instanceof RGBA) || hex(color) !== item.target
    })
    if (!wrong.length) return
    const first = Math.min(...wrong.map((item) => item.index))
    for (const item of wrong.filter((item) => item.index === first))
      write(layer(definition, item.index), item.path, item.target)
  }
}

function neutralPart(step: HueStep): AgentThemePart {
  if (step >= 800) return "background"
  if (step >= 500) return "panels"
  return "text"
}

const TOKENS = ["text", "background", "border", "scrollbar", "diff", "syntax", "markdown"]

// Which part a colour belongs to: by where it is, else by the colour it names. A dialog's background goes by the colour
// it names, a panel's in most themes.
function partOf(
  path: string[],
  value: unknown,
  surface: boolean,
  lookup: (path: string[]) => unknown,
  depth = 0,
): AgentThemePart | undefined {
  const key = path.map((segment) => segment.replace(/^\$/, "")).join(".")
  const named = typeof value === "string" && value.startsWith("$")
  if (key === "border.base" || key === "scrollbar.base") return "borders"
  if (key === "markdown.heading" || key === "markdown.link" || key === "markdown.linkText") return "headings"
  if (/^(syntax|diff|text\.feedback)\./.test(key)) return undefined
  if (key === "background.base" && !(surface && named)) return "background"
  if (key.startsWith("background.raised.")) return "panels"
  if (key === "text.base" || key === "text.muted" || key === "text.faint") return "text"
  if (!named) return undefined
  const hue = /^\$hue\.(.+)\.(\d00)$/.exec(value)
  if (hue?.[1] === "neutral") return neutralPart(Number(hue[2]) as HueStep)
  if (hue?.[1] === "interactive" || hue?.[1] === "accent") return "accents"
  if (hue || depth > 8) return undefined
  const target = value.slice(1).split(".")
  return partOf(target, lookup(target), surface, lookup, depth + 1)
}

function leaves(tokens: Record<string, unknown>) {
  const walk = (value: unknown, path: string[]): string[][] => {
    if (typeof value === "string") return [path]
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    return Object.entries(value).flatMap(([key, item]) => (key.startsWith("@") ? [] : walk(item, [...path, key])))
  }
  return TOKENS.flatMap((key) => walk(tokens[key], [key]))
}

function read(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    return record[segment] ?? record[segment.replace(/^\$/, "")]
  }, source)
}

function layer(definition: Record<string, unknown>, index: number) {
  if (index === 0) return definition
  const dialog = (definition["@dialog"] ??= {}) as Record<string, unknown>
  if (index === 1) return dialog
  return (dialog["@footer"] ??= {}) as Record<string, unknown>
}

function write(tokens: Record<string, unknown>, path: string[], value: string) {
  const parent = path
    .slice(0, -1)
    .reduce((record, segment) => (record[segment] ??= {}) as Record<string, unknown>, tokens)
  parent[path.at(-1)!] = value
}
