import { RGBA } from "@opentui/core"
import type { ThemeV1Json } from "@opencode/theme/tui/v1"
import { Option, Schema } from "effect"
import { copyTheme, hex } from "./custom"
import { parseTheme } from "./index"

// openforge (spec custom-themes): reads a colour scheme as the popular scheme sites hand them out, into a custom theme.
// Two kinds of scheme: base16/base24 (tinted-theming), whose sixteen or twenty-four colours each have a role; and
// terminal schemes, sixteen ANSI colours with a background and a foreground (iTerm2, Windows Terminal, Ghostty, kitty,
// Alacritty, Xresources, Gogh, terminal.sexy), whose roles follow the usual meaning of each ANSI colour. An opencode or
// openforge theme is taken as it is.

export type Imported = { name?: string; format: string; theme: ThemeV1Json }

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

type Terminal = { name?: string; background: string; foreground: string; ansi: string[] }
type Base = { name?: string; base: string[] }

export const formats =
  "base16 or base24 YAML, an opencode theme, or a terminal scheme (iTerm2, Windows Terminal, Ghostty, kitty, Alacritty, Xresources, Gogh, terminal.sexy)"

export function importScheme(input: string): Imported {
  const text = input.replace(/^\uFEFF/, "").trim()
  const found = read(text)
  if (!found) throw new Error(`This isn't a colour scheme openforge can read. It takes ${formats}.`)
  return found
}

function read(text: string): Imported | undefined {
  if (text.startsWith("{") || text.startsWith("[")) return fromObject(Option.getOrUndefined(decodeJson(text)))
  if (/<key>\s*Ansi 0 Color\s*<\/key>/i.test(text)) return terminal("iTerm2", iterm(text))
  if (/^\s*\[colors[.\]]/m.test(text)) return fromObject(toml(text), "Alacritty")
  if (/^\s*palette\s*=\s*\d+\s*=/m.test(text)) return terminal("Ghostty", ghostty(text))
  if (/^\s*color\d+\s+#?[\da-f]{6}\b/im.test(text)) return terminal("kitty", kitty(text))
  if (/^\s*[\w.*-]*[*.]?(color\d+|background|foreground)\s*:\s*\S/im.test(text) && /[*.]color\d+\s*:/i.test(text))
    return terminal("Xresources", xresources(text))
  return fromObject(yaml(text))
}

function fromObject(value: unknown, hint?: string): Imported | undefined {
  if (Array.isArray(value)) return fromObject(value[0], hint)
  if (!isRecord(value)) return
  if ("base00" in value) return base(value)
  if (isRecord(value.palette) && "base00" in value.palette) return base({ ...value, ...value.palette })
  if (isRecord(value.theme) || isRecord(value.base)) return opencode(value)
  if (Array.isArray(value.schemes)) return fromObject(value.schemes[0], hint)
  if (isRecord(value.colors) && isRecord(value.colors.primary)) return alacritty(value, hint ?? "Alacritty")
  if ("brightBlack" in value && "background" in value)
    return terminal("Windows Terminal", {
      name: string(value.name),
      background: color(value.background),
      foreground: color(value.foreground),
      ansi: windowsNames.map((key) => color(value[key])),
    })
  if (Array.isArray(value.color) && "background" in value)
    return terminal("terminal.sexy", {
      name: string(value.name),
      background: color(value.background),
      foreground: color(value.foreground),
      ansi: value.color.map(color),
    })
  if ("color_01" in value)
    return terminal("Gogh", {
      name: string(value.name),
      background: color(value.background),
      foreground: color(value.foreground),
      ansi: Array.from({ length: 16 }, (_, index) => color(value[`color_${String(index + 1).padStart(2, "0")}`])),
    })
}

function opencode(source: Record<string, unknown>): Imported {
  // Checks it reads; a theme of the newer format is copied into the custom format so the customizer can edit it.
  parseTheme(source as never, "imported")
  if ("theme" in source) return { format: "opencode", theme: source as ThemeV1Json }
  return { format: "opencode", theme: copyTheme(source as never, "imported") }
}

function base(value: Record<string, unknown>): Imported | undefined {
  const keys = Array.from({ length: 24 }, (_, index) => `base${index.toString(16).toUpperCase().padStart(2, "0")}`)
  const colors = keys.map((key) => value[key] ?? value[key.toLowerCase()]).map(color)
  const sixteen = colors.slice(0, 16)
  if (sixteen.some((item) => !item)) return
  const twentyFour = colors.every(Boolean)
  return {
    name: string(value.name) ?? string(value.scheme),
    format: twentyFour ? "base24" : "base16",
    theme: fromBase({ base: twentyFour ? colors : sixteen }),
  }
}

function alacritty(value: Record<string, unknown>, format: string): Imported | undefined {
  const colors = value.colors as Record<string, Record<string, unknown> | undefined>
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
  return terminal(format, {
    background: color(colors.primary?.background),
    foreground: color(colors.primary?.foreground),
    ansi: [...names.map((key) => color(colors.normal?.[key])), ...names.map((key) => color(colors.bright?.[key]))],
  })
}

function terminal(format: string, scheme: Terminal): Imported | undefined {
  const ansi = scheme.ansi.slice(0, 16)
  if (!scheme.background || !scheme.foreground || ansi.length < 8 || ansi.slice(0, 8).some((item) => !item)) return
  // A scheme with only the eight normal colours uses them for the bright ones too.
  const full = Array.from({ length: 16 }, (_, index) => ansi[index] || ansi[index - 8]!)
  return { name: scheme.name, format, theme: fromTerminal({ ...scheme, ansi: full }) }
}

// The usual meaning of each colour: ANSI 1 red, 2 green, 3 yellow, 4 blue, 5 magenta, 6 cyan, 8 the bright black of
// quiet text; base16's per tinted-theming's styling guide (00 background, 01 and 02 raised, 03 comments, 04 muted,
// 05 text, 08 red … 0E magenta; base24's 12 and 14 the bright red and green).
function fromTerminal(scheme: Terminal) {
  const [bg, fg] = [scheme.background, scheme.foreground]
  const ansi = scheme.ansi
  const muted = contrast(ansi[8]!, bg) >= 3 ? ansi[8]! : mix(fg, bg, 0.4)
  return build({
    bg,
    panel: mix(bg, fg, 0.07),
    element: mix(bg, fg, 0.14),
    fg,
    muted,
    comment: muted,
    red: ansi[1]!,
    orange: mix(ansi[1]!, ansi[3]!, 0.5),
    yellow: ansi[3]!,
    green: ansi[2]!,
    cyan: ansi[6]!,
    blue: ansi[4]!,
    magenta: ansi[5]!,
    brightRed: ansi[9]!,
    brightGreen: ansi[10]!,
  })
}

function fromBase(scheme: Base) {
  const b = scheme.base
  return build({
    bg: b[0]!,
    panel: b[1]!,
    element: b[2]!,
    fg: b[5]!,
    muted: b[4]!,
    comment: b[3]!,
    red: b[8]!,
    orange: b[9]!,
    yellow: b[10]!,
    green: b[11]!,
    cyan: b[12]!,
    blue: b[13]!,
    magenta: b[14]!,
    brightRed: b[18] ?? b[8]!,
    brightGreen: b[20] ?? b[11]!,
  })
}

type Slots = Record<
  | "bg"
  | "panel"
  | "element"
  | "fg"
  | "muted"
  | "comment"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "magenta"
  | "brightRed"
  | "brightGreen",
  string
>

function build(s: Slots): ThemeV1Json {
  return {
    $schema: "https://opencode.ai/theme.json",
    theme: {
      background: s.bg,
      backgroundPanel: s.panel,
      backgroundElement: s.element,
      backgroundMenu: s.element,
      text: s.fg,
      textMuted: s.muted,
      selectedListItemText: s.bg,
      border: mix(s.bg, s.fg, 0.22),
      borderActive: s.blue,
      borderSubtle: mix(s.bg, s.fg, 0.12),
      primary: s.blue,
      secondary: s.magenta,
      accent: s.cyan,
      error: s.red,
      warning: s.yellow,
      success: s.green,
      info: s.cyan,
      diffAdded: s.green,
      diffRemoved: s.red,
      diffContext: s.muted,
      diffHunkHeader: s.cyan,
      diffHighlightAdded: s.brightGreen,
      diffHighlightRemoved: s.brightRed,
      diffAddedBg: mix(s.bg, s.green, 0.14),
      diffRemovedBg: mix(s.bg, s.red, 0.14),
      diffContextBg: s.panel,
      diffLineNumber: s.muted,
      diffAddedLineNumberBg: mix(s.bg, s.green, 0.1),
      diffRemovedLineNumberBg: mix(s.bg, s.red, 0.1),
      markdownText: s.fg,
      markdownHeading: s.blue,
      markdownLink: s.cyan,
      markdownLinkText: s.blue,
      markdownCode: s.green,
      markdownBlockQuote: s.yellow,
      markdownEmph: s.yellow,
      markdownStrong: s.orange,
      markdownHorizontalRule: s.muted,
      markdownListItem: s.blue,
      markdownListEnumeration: s.cyan,
      markdownImage: s.cyan,
      markdownImageText: s.blue,
      markdownCodeBlock: s.fg,
      syntaxComment: s.comment,
      syntaxKeyword: s.magenta,
      syntaxFunction: s.blue,
      syntaxVariable: s.red,
      syntaxString: s.green,
      syntaxNumber: s.orange,
      syntaxType: s.yellow,
      syntaxOperator: s.cyan,
      syntaxPunctuation: s.fg,
    },
  }
}

const windowsNames = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "purple",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightPurple",
  "brightCyan",
  "brightWhite",
]

function iterm(text: string): Terminal {
  const entry = (key: string) => {
    const dict = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<dict>([\\s\\S]*?)</dict>`, "i").exec(text)?.[1]
    if (!dict) return ""
    const part = (name: string) =>
      Number(new RegExp(`<key>\\s*${name} Component\\s*</key>\\s*<real>([^<]+)</real>`, "i").exec(dict)?.[1] ?? NaN)
    const [r, g, b] = [part("Red"), part("Green"), part("Blue")]
    if ([r, g, b].some((value) => Number.isNaN(value))) return ""
    return hex(RGBA.fromValues(r, g, b, 1))
  }
  return {
    background: entry("Background Color"),
    foreground: entry("Foreground Color"),
    ansi: Array.from({ length: 16 }, (_, index) => entry(`Ansi ${index} Color`)),
  }
}

function ghostty(text: string): Terminal {
  const ansi: string[] = []
  const values: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const match = /^\s*([\w-]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const palette = /^(\d+)\s*=\s*(\S+)$/.exec(match[2]!)
    if (match[1] === "palette" && palette) ansi[Number(palette[1])] = color(palette[2])
    else values[match[1]!] = match[2]!
  }
  return { background: color(values.background), foreground: color(values.foreground), ansi }
}

function kitty(text: string): Terminal {
  const values = Object.fromEntries(
    text
      .split("\n")
      .map((line) => /^\s*([\w-]+)\s+(\S+)/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [match[1]!, match[2]!]),
  )
  return {
    background: color(values.background),
    foreground: color(values.foreground),
    ansi: Array.from({ length: 16 }, (_, index) => color(values[`color${index}`])),
  }
}

function xresources(text: string): Terminal {
  const defines: Record<string, string> = {}
  const values: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const define = /^\s*#define\s+(\S+)\s+(\S+)/.exec(line)
    if (define) defines[define[1]!] = define[2]!
    const match = /^\s*[\w.*-]*?[*.]?(color\d+|background|foreground)\s*:\s*(\S+)/i.exec(line)
    if (match && !line.trimStart().startsWith("!")) values[match[1]!.toLowerCase()] = defines[match[2]!] ?? match[2]!
  }
  return {
    background: color(values.background),
    foreground: color(values.foreground),
    ansi: Array.from({ length: 16 }, (_, index) => color(values[`color${index}`])),
  }
}

/** The part of YAML schemes use: nested maps by indentation, scalars plain or quoted, # comments. */
function yaml(text: string) {
  const root: Record<string, unknown> = {}
  const stack: { indent: number; value: Record<string, unknown> }[] = [{ indent: -1, value: root }]
  for (const line of text.split("\n")) {
    const match = /^(\s*)([^\s:#][^:]*?)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const indent = match[1]!.length
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop()
    const parent = stack.at(-1)!.value
    const key = unquote(match[2]!)
    const value = scalar(match[3]!)
    if (value === "") {
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ indent, value: child })
      continue
    }
    parent[key] = value
  }
  return root
}

/** The part of TOML schemes use: [tables] of dotted names and key = value lines. */
function toml(text: string) {
  const root: Record<string, unknown> = {}
  let table = root
  for (const line of text.split("\n")) {
    const header = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line)
    if (header) {
      table = header[1]!.split(".").reduce<Record<string, unknown>>((parent, key) => {
        const name = unquote(key.trim())
        if (!isRecord(parent[name])) parent[name] = {}
        return parent[name] as Record<string, unknown>
      }, root)
      continue
    }
    const pair = /^\s*([\w-]+|"[^"]+")\s*=\s*(.+)$/.exec(line)
    if (pair) table[unquote(pair[1]!)] = scalar(pair[2]!)
  }
  return root
}

function scalar(raw: string) {
  const value = raw.trim()
  const quoted = /^(["'])(.*?)\1/.exec(value)
  if (quoted) return quoted[2]!
  // A bare #rrggbb is a colour, not a comment, in the schemes this reads.
  const bare = /^#[\da-f]{3,8}\b/i.exec(value)
  if (bare) return bare[0]
  return value.replace(/\s+#.*$/, "").trim()
}

function unquote(value: string) {
  return value.replace(/^(["'])(.*)\1$/, "$2")
}

/** A colour as schemes write it: #rgb, #rrggbb, rrggbb, 0xrrggbb or rgb:rr/gg/bb; else "". */
function color(value: unknown): string {
  if (typeof value !== "string") return ""
  const text = value.trim().toLowerCase()
  const rgb = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/.exec(text)
  if (rgb)
    return `#${rgb
      .slice(1)
      .map((part) => part.padEnd(2, part).slice(0, 2))
      .join("")}`
  const digits = text.replace(/^(#|0x)/, "")
  if (/^[\da-f]{3}$/.test(digits)) return `#${[...digits].map((c) => c + c).join("")}`
  if (/^[\da-f]{6}$/.test(digits)) return `#${digits}`
  if (/^[\da-f]{8}$/.test(digits)) return `#${digits.slice(0, 6)}`
  return ""
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mix(a: string, b: string, amount: number) {
  const [x, y] = [RGBA.fromHex(a), RGBA.fromHex(b)]
  return hex(RGBA.fromValues(x.r + (y.r - x.r) * amount, x.g + (y.g - x.g) * amount, x.b + (y.b - x.b) * amount, 1))
}

function contrast(a: string, b: string) {
  const luminance = (value: string) => {
    const color = RGBA.fromHex(value)
    const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}
