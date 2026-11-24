import { RGBA } from "@opentui/core"
import { resolveThemeDocument, themeModes, type ResolvedTheme } from "@opencode/theme/tui"
import type { ColorValue, ThemeColor, ThemeV1Json } from "@opencode/theme/tui/v1"
import { parseTheme, type ThemeDocumentSource } from "./index"
import { resolveThemeColors } from "./resolve"

// openforge (spec custom-themes): a custom theme is a theme file of opencode's documented format (`theme` with one
// colour per role, each a hex or a dark/light pair) in the global themes folder, named by its file. The customizer
// edits its roles; a built-in or other theme is copied into one first.

export type Mode = "dark" | "light"

/** openforge (spec agent-theme): the special theme whose chosen colours follow the shown chat's agent. */
export const AGENT_THEME = "agent"

export type Role = { key: ThemeColor; title: string; group: string; help: string }

const role = (group: string) => (key: ThemeColor, title: string, help: string) => ({ key, title, group, help })
const background = role("Backgrounds")
const text = role("Text")
const border = role("Borders")
const accent = role("Accents")
const status = role("Status")
const diff = role("Diffs")
const markdown = role("Markdown")
const syntax = role("Code")

/** Every colour a theme sets, in the order the customizer lists them, with where each is used. */
export const roles: readonly Role[] = [
  background("background", "Background", "Behind everything: the chat, the home screen, the tab strip"),
  background("backgroundPanel", "Panel", "The prompt box, your messages, the sidebar and dialogs"),
  background("backgroundElement", "Raised element", "Rows and controls raised above a panel, and hovered rows"),
  background("backgroundMenu", "Menu", "Menus and lists that open over a panel"),
  text("text", "Text", "All ordinary text"),
  text("textMuted", "Muted text", "Hints, details, timestamps and other quieter text"),
  text("selectedListItemText", "Selected row text", "The text of the highlighted row in a list"),
  border("border", "Border", "Borders of panels and boxes"),
  border("borderActive", "Active border", "The border of what has the focus, and scrollbars"),
  border("borderSubtle", "Subtle border", "Faint separators"),
  accent("primary", "Primary", "The main accent: the highlighted row, the active tab, prompts"),
  accent("secondary", "Secondary", "A second accent: agents and badges"),
  accent("accent", "Accent", "A third accent: marks and links in lists"),
  status("error", "Error", "Errors and failed steps"),
  status("warning", "Warning", "Warnings and things that wait for you"),
  status("success", "Success", "Things that went well"),
  status("info", "Info", "Information and notices"),
  diff("diffAdded", "Added text", "Added lines in a diff"),
  diff("diffRemoved", "Removed text", "Removed lines in a diff"),
  diff("diffContext", "Context text", "Unchanged lines around a change"),
  diff("diffHunkHeader", "Hunk header", "The @@ line that starts a change"),
  diff("diffHighlightAdded", "Added word", "The words that changed in an added line"),
  diff("diffHighlightRemoved", "Removed word", "The words that changed in a removed line"),
  diff("diffAddedBg", "Added background", "Behind added lines"),
  diff("diffRemovedBg", "Removed background", "Behind removed lines"),
  diff("diffContextBg", "Context background", "Behind unchanged lines"),
  diff("diffLineNumber", "Line numbers", "Line numbers beside a diff"),
  diff("diffAddedLineNumberBg", "Added line number", "Behind the line number of an added line"),
  diff("diffRemovedLineNumberBg", "Removed line number", "Behind the line number of a removed line"),
  markdown("markdownText", "Text", "Ordinary text of a reply"),
  markdown("markdownHeading", "Headings", "Headings in replies"),
  markdown("markdownLink", "Links", "Link addresses"),
  markdown("markdownLinkText", "Link text", "The words of a link"),
  markdown("markdownCode", "Inline code", "`code` inside a sentence"),
  markdown("markdownBlockQuote", "Quotes", "Quoted blocks"),
  markdown("markdownEmph", "Italic", "*Italic* text"),
  markdown("markdownStrong", "Bold", "**Bold** text"),
  markdown("markdownHorizontalRule", "Rules", "Horizontal lines"),
  markdown("markdownListItem", "List bullets", "Bullets of lists"),
  markdown("markdownListEnumeration", "List numbers", "Numbers of numbered lists"),
  markdown("markdownImage", "Images", "Image links"),
  markdown("markdownImageText", "Image text", "The words of an image link"),
  markdown("markdownCodeBlock", "Code blocks", "Text of a code block without a language"),
  syntax("syntaxComment", "Comments", "Comments in code"),
  syntax("syntaxKeyword", "Keywords", "Keywords such as if, return, function"),
  syntax("syntaxFunction", "Functions", "Function and method names"),
  syntax("syntaxVariable", "Variables", "Variable and property names"),
  syntax("syntaxString", "Strings", "Text in quotes"),
  syntax("syntaxNumber", "Numbers", "Numbers and constants"),
  syntax("syntaxType", "Types", "Type and class names"),
  syntax("syntaxOperator", "Operators", "Operators such as = + =>"),
  syntax("syntaxPunctuation", "Punctuation", "Brackets, commas and dots"),
]

/** Names that can't be a custom theme's: a built-in's, the system theme's and the agent theme's. */
export function nameProblem(name: string, taken: (name: string) => boolean) {
  if (!name.trim()) return "Give the theme a name"
  if (name !== name.trim()) return "A name can't start or end with a space"
  if (name.length > 40) return "Use at most 40 characters"
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) return "Use letters, digits, spaces, dots, dashes and underscores"
  if (taken(name)) return `There is already a theme called ${name}`
}

/**
 * A copy of any theme in the custom format: every role as the colour it resolves to, a dark/light pair when the theme
 * has both modes and they differ, else one colour.
 */
export function copyTheme(source: ThemeDocumentSource, name: string): ThemeV1Json {
  const modes = themeModes(parseTheme(source, name))
  const colors = Object.fromEntries(modes.map((mode) => [mode, colorsOf(source, name, mode)])) as Partial<
    Record<Mode, Record<ThemeColor, string>>
  >
  const theme = Object.fromEntries(
    roles.map((role) => {
      const dark = colors.dark?.[role.key]
      const light = colors.light?.[role.key]
      if (dark && light && dark !== light) return [role.key, { dark, light }]
      return [role.key, (dark ?? light)!]
    }),
  ) as ThemeV1Json["theme"]
  const opacity = "theme" in source ? (source as ThemeV1Json).theme.thinkingOpacity : undefined
  return { $schema: "https://opencode.ai/theme.json", theme: opacity === undefined ? theme : { ...theme, thinkingOpacity: opacity } }
}

/** The colour a role has in a mode, as a hex. */
export function roleColor(theme: ThemeV1Json, key: ThemeColor, mode: Mode) {
  const color = resolveThemeColors(theme, mode).theme[key]
  return color ? hex(color) : undefined
}

/** Sets one role's colour for a mode, keeping the other mode's as it resolves today. */
export function setRole(theme: ThemeV1Json, key: ThemeColor, mode: Mode, color: string): ThemeV1Json {
  const other: Mode = mode === "dark" ? "light" : "dark"
  const both = themeModes(parseTheme(theme, "custom")).length === 2
  const value: ColorValue = both
    ? ({ [mode]: color, [other]: roleColor(theme, key, other) ?? color } as { dark: string; light: string })
    : color
  return { ...theme, theme: { ...theme.theme, [key]: value } }
}

function colorsOf(source: ThemeDocumentSource, name: string, mode: Mode): Record<ThemeColor, string> {
  if ("theme" in source) {
    const resolved = resolveThemeColors(source as ThemeV1Json, mode).theme
    return Object.fromEntries(roles.map((role) => [role.key, hex(resolved[role.key])])) as Record<ThemeColor, string>
  }
  return fromResolved(resolveThemeDocument(parseTheme(source, name), mode))
}

// A theme of the newer format, read back into the roles: the inverse of how the older format is read into it.
function fromResolved(theme: ResolvedTheme): Record<ThemeColor, string> {
  const of = (color: RGBA) => hex(color)
  return {
    background: of(theme.background.base),
    backgroundPanel: of(theme.background.raised.base),
    backgroundElement: of(theme.background.raised.high),
    backgroundMenu: of(theme.background.raised.high),
    text: of(theme.text.base),
    textMuted: of(theme.text.muted),
    selectedListItemText: of(theme.text.action.primary.focused),
    border: of(theme.border.base),
    borderActive: of(theme.scrollbar.base),
    borderSubtle: of(theme.background.raised.max),
    primary: of(theme.hue.interactive[200]),
    secondary: of((theme.categorical[0] ?? theme.hue.accent)[200]),
    accent: of(theme.hue.accent[200]),
    error: of(theme.text.feedback.error.base),
    warning: of(theme.text.feedback.warning.base),
    success: of(theme.text.feedback.success.base),
    info: of(theme.text.feedback.info.base),
    diffAdded: of(theme.diff.text.added),
    diffRemoved: of(theme.diff.text.removed),
    diffContext: of(theme.diff.text.context),
    diffHunkHeader: of(theme.diff.text.hunkHeader),
    diffHighlightAdded: of(theme.diff.highlight.added),
    diffHighlightRemoved: of(theme.diff.highlight.removed),
    diffAddedBg: of(theme.diff.background.added),
    diffRemovedBg: of(theme.diff.background.removed),
    diffContextBg: of(theme.diff.background.context),
    diffLineNumber: of(theme.diff.lineNumber.text),
    diffAddedLineNumberBg: of(theme.diff.lineNumber.background.added),
    diffRemovedLineNumberBg: of(theme.diff.lineNumber.background.removed),
    markdownText: of(theme.markdown.text),
    markdownHeading: of(theme.markdown.heading),
    markdownLink: of(theme.markdown.link),
    markdownLinkText: of(theme.markdown.linkText),
    markdownCode: of(theme.markdown.code),
    markdownBlockQuote: of(theme.markdown.blockQuote),
    markdownEmph: of(theme.markdown.emphasis),
    markdownStrong: of(theme.markdown.strong),
    markdownHorizontalRule: of(theme.markdown.horizontalRule),
    markdownListItem: of(theme.markdown.listItem),
    markdownListEnumeration: of(theme.markdown.listEnumeration),
    markdownImage: of(theme.markdown.image),
    markdownImageText: of(theme.markdown.imageText),
    markdownCodeBlock: of(theme.markdown.codeBlock),
    syntaxComment: of(theme.syntax.comment),
    syntaxKeyword: of(theme.syntax.keyword),
    syntaxFunction: of(theme.syntax.function),
    syntaxVariable: of(theme.syntax.variable),
    syntaxString: of(theme.syntax.string),
    syntaxNumber: of(theme.syntax.number),
    syntaxType: of(theme.syntax.type),
    syntaxOperator: of(theme.syntax.operator),
    syntaxPunctuation: of(theme.syntax.punctuation),
  }
}

export function hex(color: RGBA) {
  const [r, g, b, a] = color.toInts()
  const byte = (value: number) => value.toString(16).padStart(2, "0")
  return `#${byte(r)}${byte(g)}${byte(b)}${a === 255 ? "" : byte(a)}`
}

/** A colour typed by hand: #rgb, #rrggbb or #rrggbbaa, with or without the #; lower case. */
export function parseHex(value: string) {
  const text = value.trim().replace(/^#/, "").toLowerCase()
  if (/^[\da-f]{3}$/.test(text)) return `#${[...text].map((c) => c + c).join("")}`
  if (/^[\da-f]{6}([\da-f]{2})?$/.test(text)) return `#${text}`
}
