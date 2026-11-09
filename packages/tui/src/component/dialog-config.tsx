import type { AutoUpdateStatus, PacerSettings } from "@opencode/client"
import { Attention } from "@opencode/schema/attention"
import { Schema } from "effect"
import { createEffect, createMemo, createSignal, on, useContext } from "solid-js"
import { attentionEventDefaults, useConfig, useNewDesigns, type AttentionEvent } from "../config"
import { useOptionalAttention } from "../context/attention"
import { ClientContext } from "../context/client"
import { usePacer } from "../context/pacer"
import { useThemes } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, DialogSelectChoice } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { DialogThemeList } from "./dialog-theme-list"

type Setting = {
  title: string
  category: string
  path: string[]
  /** Shown below the list while the setting is selected, under the "new-designs" experiment. */
  description: string
  default: unknown
  values?: readonly unknown[]
  labels?: readonly string[]
  step?: number
  min?: number
  max?: number
  format?: (value: unknown) => string
  keywords?: readonly string[]
  /** Under the "new-designs" experiment, enter opens this picker instead of cycling. ←/→ still cycle. */
  open?: (dialog: DialogContext) => void
  /**
   * Kept by CLIProxyPacer for all your chats instead of in the TUI config (spec cliproxypacer-cold-ask, section 2):
   * read from it when Settings opens, written to it, and shown only while one is set up and answering. `path` is then
   * only the setting's ID.
   */
  pacer?: keyof PacerSettings
  /** openforge: a sound row of this event, which plays the sound it moves to once, as a preview. */
  preview?: AttentionEvent
  /**
   * openforge (spec auto-update): the service's automatic updates, the `update` key of its global config, instead of
   * the TUI config: read from the service when Settings opens and written to it. Shown once the service answered.
   */
  update?: true
  /**
   * openforge (spec images): a key of the service's global config, which the service reads, instead of the
   * TUI config: read from the service when Settings opens and written to it. Shown once the service answered.
   */
  service?: true
  /** openforge: the longer explanation a row's help shows. */
  help?: string
}

// openforge (notifications step 2): each event's notification switch and sound, and Subagent done's levels.
const eventRows = (
  [
    ["done", "Done", "a chat's final reply, when nothing it started still runs"],
    ["reply", "Reply", "every final reply of a chat, also while its subagents or shells run"],
    ["subagent_done", "Subagent done", "a subagent's final reply"],
    ["question", "Question", "a question, form or permission that waits for you"],
    ["error", "Error", "a failed turn"],
  ] as const
).flatMap(([event, title, what]): Setting[] => [
  {
    title: `${title}: notification`,
    category: "Alerts",
    path: ["attention", "events", event, "notification"],
    description: `Whether ${what} shows a system notification`,
    help: [
      `A system notification for ${what}. It shows only while the terminal is not focused (a terminal that doesn't report focus counts as not focused), and only for chats open in this TUI: its tabs and the chat it shows, with their subagents.`,
      ...(event === "question"
        ? ["A permission this TUI accepts by itself (Permissions: auto accept) raises none."]
        : []),
      'Needs "Notifications" on. Through tmux or ssh, see "Notification protocol".',
    ].join(" "),
    default: attentionEventDefaults[event].notification,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["alerts", "desktop notifications", event.replace("_", " ")],
  },
  {
    title: `${title}: sound`,
    category: "Alerts",
    path: ["attention", "events", event, "sound"],
    description: `The sound for ${what}; a file set in cli.json shows as its path`,
    help: `The sound played for ${what}, also while the terminal is focused, for chats open in this TUI. Moving to a sound plays it once. A sound file set in cli.json shows here as its path. Needs "Sounds" on; "Volume" sets how loud. When \`openforge notify\` runs on the machine you sit at, the sound plays there instead.`,
    default: attentionEventDefaults[event].sound,
    values: ["off", ...Attention.sounds],
    keywords: ["alerts", "audio", "sound effects", event.replace("_", " ")],
    preview: event,
  },
  ...(event === "subagent_done"
    ? [
        {
          title: `${title}: levels`,
          category: "Alerts",
          path: ["attention", "events", event, "levels"],
          description: "How many levels of subagents below a chat count; 1 is the chat's own subagents",
          help: 'Which subagents\' final replies count as "Subagent done": 1 is the subagents a chat started, 2 adds the subagents those started, and so on.',
          default: 1,
          values: [1, 2, 3, 4, 5, 6, 7, 8, 9],
          keywords: ["alerts", "depth", "subagent done"],
        },
      ]
    : []),
])

export const settings: Setting[] = [
  {
    title: "Theme",
    category: "Appearance",
    path: ["theme", "name"],
    description: "Color theme used across the interface",
    help: 'The colors of the whole interface. Enter opens the list of themes, with a preview as you move through it. The list holds the built-in themes and any theme files you added. Light and dark variants follow "Color mode".',
    default: "opencode",
    keywords: ["color scheme", "colors"],
    open: (dialog) =>
      dialog.replace(() => (
        <DialogThemeList onClose={() => dialog.replace(() => <DialogConfig current="theme.name" />)} />
      )),
  },
  {
    title: "Color mode",
    category: "Appearance",
    path: ["theme", "mode"],
    description: "Dark or light variant, or follow the system",
    help: 'Picks the dark or light variant of the theme. "system" follows the light or dark mode the terminal reports, and changes with it.',
    default: "system",
    values: ["system", "dark", "light"],
    keywords: ["dark mode", "light mode", "system theme"],
  },
  {
    title: "Animations",
    category: "Appearance",
    path: ["animations"],
    description: "Whether spinners and transitions animate",
    help: "Turns on spinners, shimmering titles and other small motion. Off, the same states show as still marks, and the screen redraws only when something changes.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["motion", "effects"],
  },
  {
    title: "Sidebar",
    category: "Session",
    path: ["session", "sidebar"],
    description: "Whether the sidebar shows when there is room",
    help: 'The side panel next to a chat, with its usage, files and other details. "auto" shows it when the window is wider than 120 columns, not counting vertical tabs; in a narrower window it opens over the chat with its key. "hide" keeps it closed until you open it.',
    default: "auto",
    values: ["hide", "auto"],
    keywords: ["side panel"],
  },
  {
    title: "Scrollbar",
    category: "Session",
    path: ["session", "scrollbar"],
    description: "Whether a scrollbar is shown next to the chat",
    help: "Shows a scrollbar at the right edge of the chat.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["scroll bar"],
  },
  {
    title: "Thinking",
    category: "Session",
    path: ["session", "thinking"],
    description: "Whether model thinking is shown in the chat",
    help: 'Whether the model\'s thinking (its reasoning before an answer) shows in the chat. Only models that send their thinking have any. The key "session.toggle.thinking", unbound by default, switches it too.',
    default: "hide",
    values: ["hide", "show"],
    keywords: ["reasoning", "chain of thought"],
  },
  {
    title: "Markdown",
    category: "Session",
    path: ["session", "markdown"],
    description: "Whether chat markdown is rendered or shown as source",
    help: '"rendered" hides Markdown\'s markers (asterisks, backticks, link brackets) and shows the formatting; "source" shows the text as the model wrote it, markers included.',
    default: "rendered",
    values: ["source", "rendered"],
    keywords: ["syntax", "concealment", "rendering"],
  },
  {
    title: "Tool grouping",
    category: "Session",
    path: ["session", "grouping"],
    description: "Whether consecutive reads and searches are grouped",
    help: '"auto" folds a run of consecutive file reads and searches into one item; "none" shows each tool call on its own.',
    default: "auto",
    values: ["none", "auto"],
    keywords: ["transcript", "messages", "reads", "searches"],
  },
  {
    title: "Verbosity",
    category: "Session",
    path: ["session", "verbosity"],
    description: "How much tool activity is shown in the chat",
    help: 'How much of a chat\'s tool work shows. "low" sums up each run of tools and thinking; "medium" shows each tool call; "high" also opens the groups of reads, searches and instructions.',
    default: "medium",
    values: ["low", "medium", "high"],
    keywords: ["detail", "activity", "summary", "transcript"],
  },
  {
    title: "Transcript images",
    category: "Session",
    path: ["session", "image_preview"],
    description: "Whether images are shown in the chat",
    help: "Shows images in the chat: those you attached and those a tool returned, up to three thumbnails per message. Clicking one opens it larger. Drawn with the terminal's own image support where it has one.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["attachments", "images", "tool output"],
  },
  {
    title: "Optimize images",
    category: "Session",
    path: ["media", "image", "optimize"],
    service: true,
    description: "Fit images to the model, keep the originals, and let the model zoom and recall them",
    help: [
      "Every image that reaches the chat (pasted, attached, or read by a tool) is converted once, on this machine, to the largest size the model reads without shrinking it itself, as WebP at the highest quality that keeps a full context of images within one request. The full-resolution original is kept with the chat.",
      "Each image is numbered, with one line before it saying its name, original size and the size it is shown at. The model's image tool lists the chat's images, shows one again (also after a compaction), or zooms into a region of the original at full detail.",
      "Images are never changed or cut once sent, so the model's prompt cache keeps working. When the images sent leave room for less than one more full-size image, the chat says so once; the next image that would not fit compacts the chat first, and the image goes out after the summary.",
      "For now this works only for claude-opus-5-5 (through Anthropic's Messages API, from any provider); other models keep today's handling. Kept in the service's global config.",
    ].join("\n\n"),
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["images", "optimize", "zoom", "screenshots", "vision", "originals"],
  },
  {
    title: "TPS",
    category: "Session",
    path: ["session", "tps"],
    description: "Whether tokens per second are shown for responses",
    help: "Shows the average tokens per second of a reply in the chat.",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["tokens per second", "throughput"],
  },
  {
    title: "New session location",
    category: "Session",
    path: ["session", "new_location"],
    description: "Directory new sessions start in",
    help: "The folder a new chat starts in: the one openforge was started in, or the folder of the chat you are in, for example its worktree.",
    default: "launch",
    values: ["launch", "inherit"],
    labels: ["launch directory", "active session"],
    keywords: ["directory", "cwd", "inherit"],
  },
  {
    title: "Permissions",
    category: "Session",
    path: ["session", "permissions"],
    description: "Whether permission requests ask you or auto accept",
    help: '"prompt" asks you before a tool does something that needs permission. "auto accept" answers yes, once each, to every request of the chat you are looking at and its subagents, and raises no notification for them. Starting openforge with --auto does the same.',
    default: "prompt",
    values: ["prompt", "autoaccept"],
    labels: ["prompt", "auto accept"],
    keywords: ["approve", "accept", "permission requests"],
  },
  {
    title: "Mode",
    category: "Tabs",
    path: ["tabs", "mode"],
    description: "Whether sessions open in tabs",
    help: 'Session tabs keep several chats open at once. "auto" turns them on, except inside herdr, which has tabs of its own; "on" and "off" always or never.',
    default: "auto",
    values: ["off", "on", "auto"],
  },
  {
    title: "Scope",
    category: "Tabs",
    path: ["tabs", "scope"],
    description: "Whether tabs are per directory or shared everywhere",
    help: '"current directory" keeps a set of tabs for each folder you start openforge in; "global" shares one set everywhere.',
    default: "cwd",
    values: ["cwd", "global"],
    labels: ["current directory", "global"],
  },
  {
    title: "Layout",
    category: "Tabs",
    path: ["tabs", "layout"],
    description: "Whether tabs run along the top or down the side",
    help: '"horizontal" puts the tabs in a strip at the top; "vertical" in a column on the left, which leaves less width for the chat.',
    default: "horizontal",
    values: ["horizontal", "vertical"],
    keywords: ["sidebar", "orientation", "left"],
  },
  {
    title: "Indicators",
    category: "Tabs",
    path: ["tabs", "indicators"],
    description: "Whether tabs show status icons or always numbers",
    help: '"status icons" marks each tab with its chat\'s state, such as working or waiting for you; "always show numbers" shows the tab\'s number instead.',
    default: "status",
    values: ["status", "numbers"],
    labels: ["status icons", "always show numbers"],
    keywords: ["tab numbers", "number mode", "status icons"],
  },
  {
    title: "Layout",
    category: "Diffs",
    path: ["diffs", "view"],
    description: "Whether diffs are side by side or in one column",
    help: 'How the diff viewer lays out changes. "auto" shows old and new side by side when the panel is wide enough, else one column; "split" and "unified" always pick one.',
    default: "auto",
    values: ["auto", "split", "unified"],
    keywords: ["diff layout", "split diff", "unified diff"],
  },
  {
    title: "Wrapping",
    category: "Diffs",
    path: ["diffs", "wrap"],
    description: "Whether long lines in diffs wrap",
    help: '"word" wraps long lines in diffs at word boundaries; "none" cuts them at the edge, so each line keeps one row.',
    default: "word",
    values: ["none", "word"],
    keywords: ["diff wrap", "word wrap", "line wrap"],
  },
  {
    title: "File tree",
    category: "Diffs",
    path: ["diffs", "tree"],
    description: "Whether a file tree is shown next to diffs",
    help: "Shows the changed files as a tree beside the diff, when the panel is wide enough. Click a file to go to it, or a folder to open or close it.",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["diff files"],
  },
  {
    title: "Single patch",
    category: "Diffs",
    path: ["diffs", "single"],
    description: "Whether diffs show one file at a time",
    help: "Shows one file's changes at a time instead of all files in one scroll; n and p move to the next and previous file.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["one file", "selected file"],
  },
  {
    title: "Scroll speed",
    category: "Input",
    path: ["scroll", "speed"],
    description: "How far each scroll step moves",
    help: 'How many lines one step of the mouse wheel or touchpad scrolls. Not used while "Acceleration" is on.',
    default: 3,
    step: 0.25,
    min: 0.25,
    max: 10,
    format: (value) => Number(value).toFixed(2),
    keywords: ["scrolling"],
  },
  {
    title: "Acceleration",
    category: "Input",
    path: ["scroll", "acceleration"],
    description: "Whether scrolling speeds up the faster you scroll",
    help: 'Scrolls further the faster you turn the wheel or swipe, as macOS does. While it is on, "Scroll speed" is not used.',
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["scroll acceleration"],
  },
  {
    title: "Mouse",
    category: "Input",
    path: ["mouse"],
    description: "Whether the interface responds to the mouse",
    help: "Lets the interface take clicks, the wheel and drag selection. Off, the mouse goes to the terminal itself, for its own selection and scrollback.",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["mouse capture"],
  },
  {
    title: "Editor context",
    category: "Input",
    path: ["prompt", "editor"],
    description: "Whether your editor's selection is added to prompts",
    help: "When an editor is connected (through its extension, or Zed), its open file and selection show above the prompt and are sent with your next message. You can dismiss one selection there; this switches the whole feature.",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["file context", "prompt context", "editor selection"],
  },
  {
    title: "Large pastes",
    category: "Input",
    path: ["prompt", "paste"],
    description: "Whether large pastes are summarized or shown in full",
    help: '"compact" shows a paste of three or more lines, or over 150 characters, as one "[Pasted ~N lines]" placeholder; the full text is still sent. "full" puts the whole text in the prompt.',
    default: "compact",
    values: ["compact", "full"],
    keywords: ["paste summary", "clipboard", "pasted content"],
  },
  {
    title: "Image previews",
    category: "Input",
    path: ["prompt", "image_preview"],
    description: "Whether attached images are previewed in the prompt",
    help: "Shows thumbnails of the images attached to the prompt, above it, before you send them.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["attachments", "clipboard", "images", "prompt"],
  },
  {
    title: "Leader timeout",
    category: "Input",
    path: ["leader", "timeout"],
    description: "How long the leader key waits for the next key",
    help: "Shortcuts like <leader>q start with the leader key. This is how long openforge waits after it for the next key before giving up.",
    default: 2000,
    step: 250,
    min: 250,
    max: 10000,
    format: (value) => `${value} ms`,
    keywords: ["leader key", "shortcut timeout"],
  },
  {
    title: "Notifications",
    category: "Alerts",
    path: ["attention", "notifications"],
    description: "Whether to notify when a session needs attention",
    help: "The main switch for system notifications; each event below has its own switch too. A notification shows only while the terminal is not focused (a terminal that doesn't report focus counts as not focused), and only for chats open in this TUI: its tabs and the chat it shows, with their subagents.",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["system notifications", "desktop notifications", "alerts"],
  },
  {
    title: "Sounds",
    category: "Alerts",
    path: ["attention", "sound"],
    description: "Whether a sound plays when a session needs attention",
    help: "The main switch for alert sounds; each event below picks its own sound too. Sounds play also while the terminal is focused, only for chats open in this TUI. When `openforge notify` runs on the machine you sit at, the sound plays there instead.",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["audio", "sound effects", "alerts"],
  },
  {
    title: "Volume",
    category: "Alerts",
    path: ["attention", "volume"],
    description: "Volume of alert sounds",
    help: "How loud alert sounds play, from 0 to 100%.",
    default: 0.4,
    step: 0.1,
    min: 0,
    max: 1,
    format: (value) => `${Math.round(Number(value) * 100)}%`,
    keywords: ["sound volume", "audio volume"],
  },
  {
    title: "Notification protocol",
    category: "Alerts",
    path: ["attention", "protocol"],
    description:
      "The terminal's notification sequence; set one when tmux or ssh hides the terminal. Applies on restart",
    help: 'The escape sequence that asks the terminal for a notification. "auto" picks it from the terminal\'s name; behind tmux it asks tmux which terminal is attached. Set one when that fails, for example over ssh: OSC 99 (kitty, foot), OSC 777 (Ghostty, WezTerm, Konsole, GNOME and other VTE terminals, Windows Terminal), OSC 9 (iTerm2, Terminal.app). Applies when openforge starts.',
    default: "auto",
    values: ["auto", "osc99", "osc777", "osc9"],
    labels: ["auto", "OSC 99", "OSC 777", "OSC 9"],
    keywords: ["tmux", "ssh", "osc", "escape sequence", "desktop notifications"],
  },
  ...eventRows,
  {
    title: "Release highlights",
    category: "Alerts",
    path: ["highlights"],
    description: "Whether release highlights are shown after an update",
    help: "After openforge updates, it shows a short list of what is new in that release once, on an idle home screen.",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["what's new", "changelog", "release notes"],
  },
  // Cache notices (spec cliproxypacer-cache-notices, section 4): OpenCodePlus's rows and defaults, this TUI's own.
  {
    title: "Cache notices",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "notices", "enabled"],
    description: "Whether a cache miss or partial reuse shows a card; none for an expired cache or a compaction",
    help: "While a chat's requests go through CLIProxyPacer, a card shows in a corner when a request missed the prompt cache or reused only part of it, and so paid for more tokens than it needed. An expired cache or a compaction shows none: those are expected. The rows below tune which cards show and for how long.",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["cache miss", "notices", "partial", "notifications"],
  },
  {
    title: "Cache notices from",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "notices", "from"],
    description: "Whose cache notices show: all chats', or the shown chat's and its subagents'",
    help: '"all chats" shows the cache notices of every chat of this service; "this chat and its subagents" only those of the chat on screen and its subagents.',
    default: "all",
    values: ["all", "chat"],
    labels: ["all chats", "this chat and its subagents"],
    keywords: ["cache miss", "notices", "sessions", "subagents"],
  },
  {
    title: "Cache notice lifetime",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "notices", "lifetime"],
    description: "How long a cache notice stays after its request",
    help: "How long a cache notice stays, counted from its request, unless you open or dismiss it first.",
    default: 15,
    values: [15, 30, 60, 120],
    labels: ["15 minutes", "30 minutes", "60 minutes", "120 minutes"],
    keywords: ["cache miss", "notices", "persist", "minutes"],
  },
  {
    title: "Cache notice minimum",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "notices", "minimum"],
    description: "The fewest tokens not reused that show a cache notice",
    help: 'A cache notice shows only when at least this many prompt tokens were not reused. "any loss" shows them all.',
    default: 0,
    values: [0, 1000, 10000, 50000, 100000],
    labels: ["any loss", "1K tokens", "10K tokens", "50K tokens", "100K tokens"],
    keywords: ["cache miss", "notices", "threshold", "tokens"],
  },
  {
    title: "Cache notices for",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "notices", "kinds"],
    description: "Whether partial reuse shows a cache notice too, or misses only",
    help: '"misses and partial reuse" shows a card for both; "misses only" leaves out requests that reused part of the cache.',
    default: "all",
    values: ["all", "misses"],
    labels: ["misses and partial reuse", "misses only"],
    keywords: ["cache miss", "notices", "partial"],
  },
  {
    title: "Opened cache notice disappears",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "notices", "dismiss"],
    description: "Whether an opened or dismissed cache notice leaves every TUI, or only this one for a day",
    help: '"in every TUI" removes a notice you opened or dismissed from all TUIs of this service; "only in this TUI" removes it here only and keeps it dismissed for a day.',
    default: "every-tui",
    values: ["every-tui", "this-tui"],
    labels: ["in every TUI", "only in this TUI"],
    keywords: ["cache miss", "notices", "dismiss", "every tui"],
  },
  {
    title: "Automatic updates",
    category: "Updates",
    path: ["update"],
    update: true,
    description:
      "Whether the background service installs a new release by itself and switches to it, at the end of the running steps; it checks every 15 minutes",
    help: "With it on, this machine's background service looks for a new openforge release when it starts and every 15 minutes, installs it next to the running one and switches to it as `openforge upgrade` does: running chats pause at the end of their step and go on after. A failed update rolls back and that release isn't tried again. Off (the default), nothing is checked in the background, and a TUI that starts says when an update is out. Each machine has its own setting, in its global config. Shows \"unavailable\", with the reason, where openforge can't update itself, such as a source checkout.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["upgrade", "update", "release", "auto update", "version"],
  },
  {
    title: "Window title",
    category: "Terminal",
    path: ["terminal", "title"],
    description: "Whether the window title shows the current session",
    help: "Sets the terminal window's title to the chat you are in (its first 40 characters), or to openforge on the home screen.",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["terminal title", "tab title"],
  },
  {
    title: "Copy behavior",
    category: "Terminal",
    path: ["terminal", "copy"],
    description: "Whether selecting text copies it",
    help: '"select" copies text to the clipboard as soon as you finish selecting it with the mouse; "manual" copies a selection when you right-click.',
    default: process.platform === "win32" ? "manual" : "select",
    values: ["manual", "select"],
    keywords: ["selection", "clipboard"],
  },
  {
    title: "Compact cold chats first",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "compact_cold_first"],
    pacer: "compactColdFirst",
    description:
      "For all chats: whether a large chat whose cache went cold compacts on a cheap model before its next step",
    help: "When a large chat's prompt cache has gone cold, its next step would pay for its whole history again. With this on, CLIProxyPacer asks openforge to compact the chat first on a cheap model it picks, so that step starts from a short summary. Only chats that compact automatically do it. This row is CLIProxyPacer's setting for all your chats; <leader>f switches it for one chat. Works only while CLIProxyPacer is connected.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["cliproxypacer", "compaction", "summary", "cold cache", "cheap model"],
  },
  {
    title: "Compact before cold",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "compact_before_cold"],
    pacer: "compactBeforeCold",
    description: "For all chats: whether an idle chat compacts on its own model before its cache goes cold",
    help: "With this on, an idle chat compacts on its own model shortly before its prompt cache goes cold, while the summary can still read the cache cheaply. A chat with a running or queued step is left alone. The toolbar shows when it will compact. This row is CLIProxyPacer's setting for all your chats; <leader>j switches it for one chat. Works only while CLIProxyPacer is connected.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["cliproxypacer", "compaction", "summary", "warm cache", "idle"],
  },
  {
    title: "Summaries written by",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "summary_writer"],
    pacer: "summaryWriter",
    description:
      "For all chats: who writes a chat's summary when it compacts; openforge does whenever CLIProxyPacer can't",
    help: 'Who writes a chat\'s summary when it compacts. "CLIProxyPacer" uses its own summary prompt, on a cheap model when the chat is cold; openforge keeps the summary as its own, so the chat goes on the same way on any provider. Claude chats follow it too: CLIProxyPacer writes their summary from the chat\'s last request, so it reads the chat\'s cache while it is warm. Where CLIProxyPacer can\'t write one, openforge does. "openforge" always writes it; on a Claude model it sends the chat\'s own request, which also reads the cache. Kept by CLIProxyPacer for all your chats.',
    default: "cliproxypacer",
    values: ["cliproxypacer", "openforge"],
    labels: ["CLIProxyPacer", "openforge"],
    keywords: ["cliproxypacer", "compaction", "summary", "writer", "server"],
  },
  {
    title: "Keep my messages in summaries",
    category: "CLIProxyPacer",
    path: ["cliproxypacer", "keep_user_messages"],
    pacer: "keepUserMessages",
    description: "For all chats: whether CLIProxyPacer keeps your earlier messages word for word after its summaries",
    help: "When CLIProxyPacer writes a chat's summary, it also keeps your own earlier messages word for word after it, so the model still sees exactly what you asked. Makes the summary longer, and has no effect when openforge writes the summary. Kept by CLIProxyPacer for all your chats.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["cliproxypacer", "compaction", "summary", "user messages", "prompts"],
  },
  {
    title: "Developer tools",
    category: "Debug",
    path: ["debug", "devtools"],
    description: "Whether the developer tools bar is shown",
    help: "Shows a bar of diagnostics: the service, the theme, the tools, and the interface's own CPU, memory and delay. While it shows, it samples them every 2 seconds.",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["debug bar", "developer tools"],
  },
]

export function settingID(setting: Setting) {
  return setting.path.join(".")
}

/**
 * Which Settings rows show, one rule for Settings and the command palette: the palette lists a row only where Settings
 * would show it. Each reads CLIProxyPacer's own settings when it opens, and again when CLIProxyPacer answers again
 * while it is open.
 */
export function useShownSettings() {
  const pacer = usePacer()
  // Automatic updates are the service's: read once when Settings opens. Without a service, as in some tests, the row
  // stays hidden.
  const client = useContext(ClientContext)
  const [updateStatus, setUpdateStatus] = createSignal<AutoUpdateStatus>()
  void client?.api.experimental.update.get().then(setUpdateStatus, () => undefined)
  // The service's own config keys: the last document that sets each, as the service reads them. Their rows show while
  // the read is under way, so the list doesn't move when it answers; null hides them: no service, or no answer.
  const [serviceConfig, setServiceConfig] = createSignal<ServiceConfig | null | undefined>(client ? undefined : null)
  const readServiceConfig = () =>
    client?.api.config.get().then(
      (entries) =>
        setServiceConfig({
          optimize:
            entries
              .flatMap((entry) => (entry.type === "document" ? [entry.info.media?.image?.optimize] : []))
              .findLast((value) => value !== undefined) ?? false,
        }),
      () => setServiceConfig(null),
    )
  void readServiceConfig()
  // CLIProxyPacer's rows: each shown while it is on and its read answered with the row's value.
  const [pacerValues, setPacerValues] = createSignal<PacerSettings>()
  createEffect(
    on(
      () => pacer?.state() === "on",
      (answering) => {
        setPacerValues(undefined)
        if (!answering) return
        pacer!.settings().then(
          (values) => setPacerValues(values),
          () => undefined,
        )
      },
    ),
  )
  // Settings › CLIProxyPacer shows only while CLIProxyPacer answers, as its other screens do: its own settings are read
  // from it, and the cache notices' rows tune what only it sends.
  const shown = (setting: Setting) => {
    if (setting.update) return updateStatus() !== undefined
    if (setting.service) return serviceConfig() !== null
    return (
      setting.category !== "CLIProxyPacer" ||
      (pacer?.state() === "on" && (setting.pacer === undefined || pacerValues()?.[setting.pacer] !== undefined))
    )
  }
  return {
    shown,
    pacerValues,
    setPacerValues,
    updateStatus,
    setUpdateStatus,
    client,
    serviceConfig,
    readServiceConfig,
  }
}

type ServiceConfig = { readonly optimize: boolean }

export function DialogConfig(props: { current?: string }) {
  const config = useConfig()
  const newDesigns = useNewDesigns()
  const dialog = useDialog()
  const toast = useToast()
  const themes = useThemes()
  const pacer = usePacer()
  const attention = useOptionalAttention()
  const current = Math.max(
    0,
    settings.findIndex((setting) => settingID(setting) === props.current),
  )
  const [selected, setSelected] = createSignal(current)
  const [saving, setSaving] = createSignal(false)
  const { shown, pacerValues, setPacerValues, updateStatus, setUpdateStatus, client, serviceConfig, readServiceConfig } =
    useShownSettings()
  // The setting Settings opens at, once it shows: a CLIProxyPacer row shows once its read answered. A memo, so a write's
  // new values don't move the selection back to it.
  const opening = createMemo(() => (shown(settings[current]) ? current : undefined))

  const value = (setting: Setting) => {
    if (setting.pacer) return pacerValues()?.[setting.pacer] ?? setting.default
    if (setting.update) return updateStatus()?.enabled ?? setting.default
    if (setting.service) return serviceConfig()?.optimize ?? setting.default
    const current = setting.path.reduce<unknown>((result, key) => {
      if (!result || typeof result !== "object") return undefined
      return (result as Record<string, unknown>)[key]
    }, config.data)
    if (setting.path.join(".") === "theme.name") return current ?? themes.selected
    return current ?? setting.default
  }
  const values = (setting: Setting) =>
    setting.path.join(".") === "theme.name"
      ? Object.keys(themes.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      : setting.values
  const display = (setting: Setting) => {
    if (setting.update && updateStatus()?.unavailable) return "unavailable"
    const current = value(setting)
    if (setting.format) return setting.format(current)
    const index = setting.values?.indexOf(current)
    return index === undefined || index < 0 ? String(current) : (setting.labels?.[index] ?? String(current))
  }
  const options = createMemo(() =>
    settings.map((setting, index) => ({
      title: setting.title,
      category: setting.category,
      searchText: setting.keywords?.join(" "),
      footer: newDesigns() ? (
        <DialogSelectChoice value={display(setting)} active={selected() === index} open={setting.open !== undefined} />
      ) : (
        display(setting)
      ),
      footerOverhang: newDesigns() ? 2 : undefined,
      detail: newDesigns() ? (setting.update && updateStatus()?.unavailable) || setting.description : undefined,
      help: setting.help,
      disabled: !shown(setting),
      value: index,
    })),
  )

  async function change(direction: number, index = selected()) {
    if (saving()) return
    const setting = settings[index]
    if (!shown(setting)) return
    // Where it can't update, the row says why instead of changing.
    const unavailable = setting.update ? updateStatus()?.unavailable : undefined
    if (unavailable) return toast.show({ variant: "info", message: unavailable })
    const current = value(setting)
    const choices = values(setting)
    const next = choices
      ? choices[(choices.indexOf(current) + direction + choices.length) % choices.length]
      : Math.min(setting.max!, Math.max(setting.min!, Number(current) + direction * setting.step!))
    if (next === current) return
    if (setting.preview && Schema.is(Attention.SoundID)(next)) preview(setting.preview, next)
    setSaving(true)
    if (setting.update) {
      await client!.api.experimental.update
        .set({ enabled: next === true })
        .then(setUpdateStatus)
        .catch(toast.error)
        .finally(() => setSaving(false))
      return
    }
    if (setting.service) {
      await client!.api.experimental.config
        .update({ media: { image: { optimize: next === true } } })
        .then(readServiceConfig)
        .catch(toast.error)
        .finally(() => setSaving(false))
      return
    }
    if (setting.pacer) {
      await pacer!
        // One of the row's own values, which are the setting's.
        .updateSettings({ [setting.pacer]: next } as Partial<PacerSettings>)
        .then((values) => setPacerValues(values))
        .catch(toast.error)
        .finally(() => setSaving(false))
      return
    }
    await config
      .update((draft) => {
        const parent = setting.path.slice(0, -1).reduce<Record<string, unknown>>((result, key) => {
          if (!result[key] || typeof result[key] !== "object") result[key] = {}
          return result[key] as Record<string, unknown>
        }, draft)
        parent[setting.path.at(-1)!] = next
      })
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  // Through the same report as an event, so a connected player plays it where you sit; never a notification.
  function preview(event: AttentionEvent, id: Attention.SoundID) {
    void attention?.raise({
      kind: event,
      message: `Sound preview: ${id}`,
      notification: false,
      sound: { when: "always", id },
    })
  }

  return (
    <DialogSelect
      title="Settings"
      searchInTitle
      titlePlaceholder="Search settings"
      options={options()}
      // Under new designs the opening setting is focused without the current-item marker; changing a value keeps the
      // selection where it is.
      current={newDesigns() ? undefined : opening()}
      focusTarget={newDesigns() ? opening() : undefined}
      preserveSelection={newDesigns()}
      filterThreshold={0.7}
      onMove={(option) => setSelected(option.value)}
      onSelect={(option) => {
        const open = settings[option.value].open
        if (newDesigns() && open) return open(dialog)
        void change(1, option.value)
      }}
      footerHints={newDesigns() ? [] : [{ title: "change", label: "←/→" }]}
      bindings={[
        {
          bind: "left",
          title: "Previous value",
          group: "Settings",
          run: () => void change(-1),
        },
        {
          bind: "right",
          title: "Next value",
          group: "Settings",
          run: () => void change(1),
        },
      ]}
    />
  )
}
