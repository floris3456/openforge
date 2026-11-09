export * as Config from "."

import { createBindingLookup } from "@opentui/keymap/extras"
import { Product } from "@opencode/schema/product"
import { Vcs } from "@opencode/schema/vcs"
import { Attention } from "@opencode/schema/attention"
import { Effect, Option, Schema } from "effect"
import { createContext, createMemo, onCleanup, type JSX, useContext } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { safeWatch } from "../util/watch"
import path from "path"
import { TuiKeybind } from "./keybind"

export interface Interface {
  readonly path?: string
  readonly get: () => Promise<Info>
  readonly update: (update: (draft: any) => void) => Promise<Info>
}

export const AttentionSoundName = Schema.Literals([
  "default",
  "question",
  "permission",
  "error",
  "done",
  "subagent_done",
])
export type AttentionSoundName = Schema.Schema.Type<typeof AttentionSoundName>
// openforge: the terminal's notification escape sequence; OpenTUI detects it (`auto`), or it is set.
export const AttentionProtocol = Schema.Literals(["auto", "osc99", "osc777", "osc9"])
export type AttentionProtocol = Schema.Schema.Type<typeof AttentionProtocol>
export type AttentionSoundPaths = Partial<Record<AttentionSoundName, string>>

// openforge (notifications step 2): five events, each with its own notification switch and sound. A value that isn't
// one of a field's own is read as unset, so a mistake in one field takes no other setting with it.
const lenient = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none())))
export const AttentionEventSound = Schema.Union([
  Schema.Literal("off"),
  Attention.SoundID,
  Schema.String.check(Schema.isPattern(/^\//)),
]).annotate({ description: "off, a built-in sound (alert-01 … yup-06), or the absolute path of a sound file" })
export type AttentionEventSound = Schema.Schema.Type<typeof AttentionEventSound>
export const AttentionEvent = ["done", "reply", "subagent_done", "question", "error"] as const
export type AttentionEvent = (typeof AttentionEvent)[number]
const eventFields = (what: string) => ({
  notification: Schema.optional(lenient(Schema.Boolean)).annotate({
    description: `Show a system notification for ${what}`,
  }),
  sound: Schema.optional(lenient(AttentionEventSound)).annotate({ description: `The sound for ${what}` }),
})
export const AttentionEvents = Schema.Struct({
  done: Schema.optional(
    lenient(Schema.Struct(eventFields("a chat's final reply while nothing it started still runs"))),
  ),
  reply: Schema.optional(lenient(Schema.Struct(eventFields("every final reply of a chat")))),
  subagent_done: Schema.optional(
    lenient(
      Schema.Struct({
        ...eventFields("a subagent's final reply"),
        levels: Schema.optional(lenient(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9 })))).annotate({
          description: "How many levels of subagents below a chat count, 1 to 9 (1: the chat's own subagents)",
        }),
      }),
    ),
  ),
  question: Schema.optional(lenient(Schema.Struct(eventFields("a question, a form or a permission that waits")))),
  error: Schema.optional(lenient(Schema.Struct(eventFields("a failed turn")))),
})
export type ResolvedAttentionEvent = { notification: boolean; sound: AttentionEventSound }
export type ResolvedAttentionEvents = Record<AttentionEvent, ResolvedAttentionEvent> & {
  subagent_done: { levels: number }
  /** The sound of a permission: the question's, or while that is unset a file in the old `attention.sounds.permission`. */
  question: { permission: AttentionEventSound }
}
export const attentionEventDefaults: Record<AttentionEvent, ResolvedAttentionEvent> = {
  done: { notification: true, sound: "bip-bop-01" },
  reply: { notification: false, sound: "off" },
  subagent_done: { notification: false, sound: "off" },
  question: { notification: true, sound: "bip-bop-03" },
  error: { notification: true, sound: "nope-03" },
}

export const MiniWorkSpinner = Schema.Literals([
  "block-soft-slide",
  "block-soft-sweep",
  "block-low-comet",
  "block-low-duet",
  "block-shuttle",
  "block-bridge",
  "block-squeeze",
  "small-toggle",
  "square-toggle",
  "grow-shrink",
  "quadrant-orbit",
  "crosshatch",
  "density-wave",
  "seed",
])
export type MiniWorkSpinner = Schema.Schema.Type<typeof MiniWorkSpinner>

export const Plugin = Schema.Union([
  Schema.String,
  Schema.Struct({
    package: Schema.String.annotate({ description: "Plugin package name or path" }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)).annotate({
      description: "Options passed to the plugin",
    }),
  }),
])

export const DiffSource = Schema.Union([Vcs.Mode, Schema.Literal("turn")])
export type DiffSource = Schema.Schema.Type<typeof DiffSource>

export const Cursor = Schema.Struct({
  style: Schema.optional(Schema.Literals(["block", "underline", "line", "default"])).annotate({
    description: "Cursor shape. Use 'default' to preserve the terminal setting",
  }),
  blinking: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the cursor blinks. Has no effect when style is 'default'",
  }),
}).annotate({ description: "Terminal cursor settings" })

export const Info = Schema.Struct({
  theme: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String).annotate({ description: "Theme name" }),
      mode: Schema.optional(Schema.Literals(["system", "dark", "light"])).annotate({
        description: "Color mode; 'system' follows the terminal",
      }),
    }),
  ).annotate({ description: "Color theme settings" }),
  keybinds: Schema.optional(TuiKeybind.KeybindOverrides).annotate({ description: "Custom key bindings" }),
  plugins: Schema.optional(Schema.Array(Plugin)).annotate({
    description: "Ordered plugin enablement directives and external package declarations",
  }),
  leader: Schema.optional(
    Schema.Struct({
      timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
        description: "Time in milliseconds to wait for a key after the leader key",
      }),
    }),
  ).annotate({ description: "Leader key behavior" }),
  scroll: Schema.optional(
    Schema.Struct({
      speed: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0.001))).annotate({
        description: "Distance scrolled per input tick",
      }),
      acceleration: Schema.optional(Schema.Boolean).annotate({
        description: "Accelerate scrolling from repeated input",
      }),
    }),
  ).annotate({ description: "Scrolling behavior" }),
  attention: Schema.optional(
    Schema.Struct({
      notifications: Schema.optional(Schema.Boolean).annotate({ description: "Show system notifications" }),
      sound: Schema.optional(Schema.Boolean).annotate({ description: "Play attention sounds" }),
      volume: Schema.optional(
        Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
      ).annotate({ description: "Attention sound volume from 0 to 1" }),
      sound_pack: Schema.optional(Schema.String).annotate({ description: "Active attention sound pack ID" }),
      sounds: Schema.optional(Schema.Record(AttentionSoundName, Schema.optionalKey(Schema.String))).annotate({
        description: "Sound file overrides by attention event",
      }),
      protocol: Schema.optional(AttentionProtocol).annotate({
        description:
          "Notification escape sequence: 'auto' detects it; osc99, osc777 or osc9 for a terminal that is not recognised through tmux or ssh. Read when the TUI starts",
      }),
      events: Schema.optional(lenient(AttentionEvents)).annotate({
        description:
          "Each event's notification and sound: done, reply, subagent_done, question and error. A value that is not valid counts as unset",
      }),
    }),
  ).annotate({ description: "System notification and sound settings" }),
  cliproxypacer: Schema.optional(
    Schema.Struct({
      notices: Schema.optional(
        Schema.Struct({
          enabled: Schema.optional(Schema.Boolean).annotate({
            description:
              "Show a card in the corner for a cache miss or partial reuse on CLIProxyPacer; none for an expired cache or a compaction",
          }),
          from: Schema.optional(Schema.Literals(["all", "chat"])).annotate({
            description: "Cache notices of all chats, or of the shown chat and its subagents only",
          }),
          lifetime: Schema.optional(Schema.Literals([15, 30, 60, 120])).annotate({
            description: "Minutes a cache notice stays after its request",
          }),
          minimum: Schema.optional(Schema.Literals([0, 1000, 10000, 50000, 100000])).annotate({
            description: "The fewest tokens not reused that raise a cache notice; 0 for any loss",
          }),
          kinds: Schema.optional(Schema.Literals(["all", "misses"])).annotate({
            description: "Cache notices for misses and partial reuse, or for misses only",
          }),
          dismiss: Schema.optional(Schema.Literals(["every-tui", "this-tui"])).annotate({
            description:
              "Whether an opened or dismissed cache notice disappears from every TUI, or only from this one, which keeps it dismissed for a day",
          }),
        }),
      ).annotate({ description: "Cache notices" }),
    }),
  ).annotate({ description: "CLIProxyPacer settings of this TUI" }),
  diffs: Schema.optional(
    Schema.Struct({
      source: Schema.optional(DiffSource).annotate({
        description:
          "Initial diff source; defaults to 'branch' (branch and uncommitted changes). 'turn' shows the session's last turn and falls back to 'branch' outside a session",
      }),
      wrap: Schema.optional(Schema.Literals(["word", "none"])).annotate({
        description: "Line wrapping behavior in diff output",
      }),
      tree: Schema.optional(Schema.Boolean).annotate({ description: "Show the diff file tree" }),
      single: Schema.optional(Schema.Boolean).annotate({ description: "Show only the selected file patch" }),
      fullscreen: Schema.optional(Schema.Boolean).annotate({
        description: "Open the diff side panel full screen; remembers the last full screen toggle",
      }),
      view: Schema.optional(Schema.Literals(["auto", "split", "unified"])).annotate({
        description: "Diff layout; 'auto' selects a layout from the available width",
      }),
    }),
  ).annotate({ description: "Diff presentation settings" }),
  terminal: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.Boolean).annotate({ description: "Update the terminal window title" }),
      copy: Schema.optional(Schema.Literals(["manual", "select"])).annotate({
        description: "Copy text manually or immediately after selecting it",
      }),
    }),
  ).annotate({ description: "Terminal integration settings" }),
  prompt: Schema.optional(
    Schema.Struct({
      editor: Schema.optional(Schema.Boolean).annotate({
        description: "Include the active editor file or selection as prompt context",
      }),
      paste: Schema.optional(Schema.Literals(["compact", "full"])).annotate({
        description: "Display large pastes as compact placeholders or full text",
      }),
      image_preview: Schema.optional(Schema.Boolean).annotate({
        description: "Show image attachment previews above the prompt input",
      }),
    }),
  ).annotate({ description: "Prompt input behavior" }),
  session: Schema.optional(
    Schema.Struct({
      sidebar: Schema.optional(Schema.Literals(["auto", "hide"])).annotate({
        description: "Session sidebar visibility; 'auto' shows it when space permits",
      }),
      scrollbar: Schema.optional(Schema.Boolean).annotate({ description: "Show the session transcript scrollbar" }),
      thinking: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide model reasoning by default",
      }),
      grouping: Schema.optional(Schema.Literals(["auto", "none"])).annotate({
        description: "Group related transcript items automatically or render each item separately",
      }),
      verbosity: Schema.optional(Schema.Literals(["low", "medium", "high"])).annotate({
        description:
          "Transcript detail level: low summarizes each run of tools and thoughts, high opens exploration and instruction groups",
      }),
      image_preview: Schema.optional(Schema.Boolean).annotate({
        description:
          "No longer used: each image shows in the transcript as the line the model got, and a click opens it. Kept so older configs stay valid",
      }),
      tps: Schema.optional(Schema.Boolean).annotate({
        description: "Show average tokens per second",
      }),
      markdown: Schema.optional(Schema.Literals(["source", "rendered"])).annotate({
        description: "Show Markdown syntax markers or conceal them in rendered transcript content",
      }),
      new_location: Schema.optional(Schema.Literals(["launch", "inherit"])).annotate({
        description: "Start new sessions in the TUI launch directory or inherit the active session location",
      }),
      permissions: Schema.optional(Schema.Literals(["prompt", "autoaccept"])).annotate({
        description: "Prompt for permission requests or accept them automatically",
      }),
    }),
  ).annotate({ description: "Session transcript presentation settings" }),
  tabs: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.Literals(["auto", "on", "off"])).annotate({
        description: "Use session tabs always, never, or when the terminal environment supports them",
      }),
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Legacy tab toggle; use mode instead",
      }),
      scope: Schema.optional(Schema.Literals(["global", "cwd"])).annotate({
        description: "Share tabs globally or keep a separate set for each working directory",
      }),
      layout: Schema.optional(Schema.Literals(["horizontal", "vertical"])).annotate({
        description: "Show tabs in a horizontal strip or vertical sidebar",
      }),
      indicators: Schema.optional(Schema.Literals(["status", "numbers"])).annotate({
        description: "Show status icons or always show tab numbers",
      }),
    }),
  ).annotate({ description: "Tab strip settings" }),
  mini: Schema.optional(
    Schema.Struct({
      thinking: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide model reasoning",
      }),
      tools: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide tool calls and the assistant text that precedes them",
      }),
      shell_output: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide raw shell tool output",
      }),
      turn_summary: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide the agent, model, and duration summary in scrollback",
      }),
      footer: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide persistent activity, model, usage, and context details in the footer",
      }),
      splash: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide the entry and exit splash banners",
      }),
      work_spinner: Schema.optional(MiniWorkSpinner).annotate({
        description: "Work spinner animation in the Mini footer (default: block-soft-slide)",
      }),
      mono: Schema.optional(Schema.Boolean).annotate({
        description: "Use monochrome ASCII output",
      }),
      replay: Schema.optional(Schema.Boolean).annotate({
        description: "Restore session history on resume and terminal resize",
      }),
      replay_limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
        description: "Maximum number of newest messages restored during replay",
      }),
    }),
  ).annotate({ description: "Mini transcript presentation settings" }),
  debug: Schema.optional(
    Schema.Struct({
      devtools: Schema.optional(Schema.Boolean).annotate({ description: "Show the DevTools debug bar" }),
      timing: Schema.optional(Schema.Boolean).annotate({ description: "Show time-to-first-draw diagnostics" }),
      turn_tokens: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("verbose")])).annotate({
        description: "Show per-turn token usage diagnostics, optionally with tool call inputs",
      }),
    }),
  ).annotate({ description: "Debugging settings" }),
  experimental: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description: "Experimental features that may change or be removed at any time",
  }),
  animations: Schema.optional(Schema.Boolean).annotate({ description: "Enable interface animations" }),
  highlights: Schema.optional(Schema.Boolean).annotate({
    description: `Show the release highlights once after ${Product.name} updates`,
  }),
  mouse: Schema.optional(Schema.Boolean).annotate({ description: "Enable terminal mouse capture" }),
  cursor: Schema.optional(Cursor),
})
export type Info = Schema.Schema.Type<typeof Info>

export type Resolved = Omit<Info, "attention" | "cursor" | "keybinds" | "leader" | "mouse" | "session" | "tabs"> & {
  attention: {
    notifications: boolean
    sound: boolean
    volume: number
    sound_pack: string
    sounds: AttentionSoundPaths
    protocol: AttentionProtocol
    events: ResolvedAttentionEvents
  }
  keybinds: TuiKeybind.BindingLookupView
  leader: { timeout: number }
  mouse: boolean
  cursor: {
    style: "block" | "underline" | "line" | "default"
    blinking: boolean
  }
  session: Omit<NonNullable<Info["session"]>, "new_location" | "permissions" | "tps"> & {
    new_location: "launch" | "inherit"
    permissions: "prompt" | "autoaccept"
    tps: boolean
  }
  tabs: {
    mode: "auto" | "on" | "off"
    enabled: boolean
    scope: "global" | "cwd"
    layout: "horizontal" | "vertical"
    indicators: "status" | "numbers"
  }
}

export function resolve(
  input: Info,
  options: { terminalSuspend: boolean; environment?: Readonly<Record<string, string | undefined>> },
): Resolved {
  const tabsMode = input.tabs?.mode ?? (input.tabs?.enabled === undefined ? "auto" : input.tabs.enabled ? "on" : "off")
  const keybinds: TuiKeybind.KeybindOverrides = { ...input.keybinds }
  if (!options.terminalSuspend) {
    keybinds["terminal.suspend"] = "none"
    if (keybinds["input.undo"] === undefined) {
      const inputUndo = TuiKeybind.defaultValue("input.undo")
      keybinds["input.undo"] = ["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(",")
    }
  }

  return {
    ...input,
    attention: {
      // openforge: notifications and sounds are on by default.
      notifications: input.attention?.notifications ?? true,
      sound: input.attention?.sound ?? true,
      volume: input.attention?.volume ?? 0.4,
      sound_pack: input.attention?.sound_pack ?? "opencode.default",
      sounds: input.attention?.sounds ?? {},
      protocol: input.attention?.protocol ?? "auto",
      events: resolveEvents(input.attention),
    },
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse(keybinds)), {
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader: { timeout: input.leader?.timeout ?? 2000 },
    mouse: input.mouse ?? true,
    cursor: {
      style: input.cursor?.style ?? "block",
      blinking: input.cursor?.blinking ?? true,
    },
    session: {
      ...input.session,
      new_location: input.session?.new_location ?? "launch",
      permissions: input.session?.permissions ?? "prompt",
      tps: input.session?.tps ?? true,
    },
    tabs: {
      ...input.tabs,
      mode: tabsMode,
      enabled: tabsMode === "on" || (tabsMode === "auto" && (options.environment ?? process.env).HERDR_ENV !== "1"),
      scope: input.tabs?.scope ?? "cwd",
      layout: input.tabs?.layout ?? "horizontal",
      indicators: input.tabs?.indicators ?? "status",
    },
  }
}

// An event's sound while it is unset: the file of its kind in the old `attention.sounds`, else its default.
function resolveEvents(attention: Info["attention"]): ResolvedAttentionEvents {
  const events = attention?.events
  const legacy = attention?.sounds ?? {}
  const event = (name: AttentionEvent, file: string | undefined) => ({
    notification: events?.[name]?.notification ?? attentionEventDefaults[name].notification,
    sound: events?.[name]?.sound ?? file ?? attentionEventDefaults[name].sound,
  })
  return {
    done: event("done", legacy.done),
    reply: event("reply", undefined),
    subagent_done: { ...event("subagent_done", legacy.subagent_done), levels: events?.subagent_done?.levels ?? 1 },
    question: {
      ...event("question", legacy.question),
      permission: events?.question?.sound ?? legacy.permission ?? attentionEventDefaults.question.sound,
    },
    error: event("error", legacy.error),
  }
}

const ConfigContext = createContext<{
  data: Resolved
  path?: string
  update: Interface["update"]
}>()

export function ConfigProvider(props: {
  config: Resolved
  service?: Interface
  options?: { terminalSuspend: boolean; environment?: Readonly<Record<string, string | undefined>> }
  children: JSX.Element
}) {
  const [config, setConfig] = createStore(props.config)
  const host = props.service
  const apply = (info: Info) => setConfig(reconcile(resolve(info, props.options ?? { terminalSuspend: true })))
  const update = async (update: (draft: any) => void) => {
    if (!host) throw new Error("Config updates are not available")
    const info = await host.update(update)
    apply(info)
    return info
  }
  let reload = Promise.resolve()
  const watcher = host?.path
    ? safeWatch(path.dirname(host.path), () => {
        reload = reload
          .then(() => host.get())
          .then(apply)
          .catch(() => {})
      })
    : undefined
  onCleanup(() => watcher?.close())
  return (
    <ConfigContext.Provider value={{ data: config, path: host?.path, update }}>{props.children}</ConfigContext.Provider>
  )
}

export function useConfig() {
  const value = useContext(ConfigContext)
  if (!value) throw new Error("ConfigProvider is missing")
  return value
}

/**
 * The configured textarea cursor, replaced only when the cursor config changes. A fresh object on every render effect
 * would restyle the textarea whenever an unrelated prop changes, discarding a style a plugin set on it.
 */
export function useCursorStyle() {
  const config = useConfig()
  return createMemo(() => ({ style: config.data.cursor.style, blinking: config.data.cursor.blinking }))
}

/** Reactive accessor for the temporary "new-designs" experiment. */
export function useNewDesigns() {
  const config = useConfig()
  return () => config.data.experimental?.["new-designs"] === true
}

/** Reactive accessor for the temporary "client-mcp" experiment. */
export function useClientMcpExperiment() {
  const config = useConfig()
  return () => config.data.experimental?.["client-mcp"] === true
}
