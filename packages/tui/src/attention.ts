/// <reference path="./audio.d.ts" />
import type {
  Attention,
  AttentionNotifyOptions,
  AttentionNotifyResult,
  AttentionNotifySkipReason,
  AttentionWhen,
} from "@opencode/plugin/tui/context"
import { Config } from "./config"
import { Schema } from "effect"
import { kindSounds, type Kind, type SoundID } from "@opencode/schema/attention"
import { Product } from "@opencode/schema/product"
import { SessionID } from "@opencode/schema/session-id"
import stripAnsi from "strip-ansi"
import * as TuiAudio from "./audio"
import { soundFiles } from "#attention-sounds"
import { noPlayers, type Report } from "./attention-report"

type FocusState = "unknown" | "focused" | "blurred"

type AttentionRenderer = {
  readonly isDestroyed: boolean
  on(event: "focus" | "blur", listener: () => void): unknown
  off(event: "focus" | "blur", listener: () => void): unknown
  triggerNotification(message: string, title?: string): boolean
}

/**
 * openforge: one occurrence as the TUI raises it, from a plugin's request or from its own events
 * (`attention-events.ts`), which choose its sound themselves.
 */
export type AttentionRequest = {
  readonly kind: Kind
  readonly sessionID?: string
  readonly title?: string
  readonly message: string
  /** When it may show a desktop notification; false for none. */
  readonly notification: AttentionWhen | false
  /** Its sound: a file, else a built-in one by ID, else the kind's; false for none. */
  readonly sound:
    | { readonly when: AttentionWhen; readonly volume?: number; readonly id?: SoundID; readonly file?: string }
    | false
}

export type AttentionHost = Attention & {
  /** openforge: raises an occurrence whose sound its caller chose. */
  raise(request: AttentionRequest): Promise<AttentionNotifyResult>
  /** openforge: the settings of the TUI's own events. */
  settings(): Config.Resolved["attention"]
  /** openforge: whether the TUI raises this chat's events (one of its own chats). */
  ours(sessionID: string): Promise<boolean>
  dispose(): void
}

const DEFAULT_TITLE = Product.name
const TITLE_LIMIT = 80
const MESSAGE_LIMIT = 240
/** Every built-in sound's file, by its ID. */
export const SOUND_FILES = soundFiles
/** Each kind's built-in sound's file. */
export const BUILTIN_SOUNDS = Object.fromEntries(
  Object.entries(kindSounds).map(([kind, id]) => [kind, soundFiles[id]]),
) as Record<Kind, string>

function skipped(reason: AttentionNotifySkipReason): AttentionNotifyResult {
  return {
    ok: false,
    notification: false,
    sound: false,
    skipped: reason,
  }
}

function normalizeText(input: string | undefined, fallback: string, limit: number) {
  const text = stripAnsi(input ?? "")
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
  const normalized = text.length ? text : fallback
  return Array.from(normalized).slice(0, limit).join("")
}

function clampVolume(volume: number) {
  if (!Number.isFinite(volume)) return 0
  return Math.min(1, Math.max(0, volume))
}

// A plugin's request: its sound by name, with the file the old `attention.sounds` sets for that name.
function requestOf(input: AttentionNotifyOptions, sounds: Config.AttentionSoundPaths): AttentionRequest {
  const sound = typeof input.sound === "object" ? input.sound : undefined
  const name = sound?.name && Schema.is(Config.AttentionSoundName)(sound.name) ? sound.name : "default"
  return {
    kind: name,
    sessionID: input.sessionID,
    title: input.title,
    message: input.message,
    notification:
      input.notification === false
        ? false
        : typeof input.notification === "object"
          ? (input.notification.when ?? "blurred")
          : "blurred",
    sound: input.sound === false ? false : { when: sound?.when ?? "always", volume: sound?.volume, file: sounds[name] },
  }
}

function focusSkip(when: AttentionWhen, focus: FocusState) {
  if (when === "always") return
  // openforge: unknown focus (tmux without focus-events) counts as not focused, so a notification shows.
  if (focus === "unknown") return when === "focused" ? "focus_unknown" : undefined
  if (when === "blurred" && focus === "focused") return "focused"
  if (when === "focused" && focus === "blurred") return "blurred"
}

export function createTuiAttention(input: {
  renderer: AttentionRenderer
  config: Pick<Config.Resolved, "attention">
  audio?: Pick<typeof TuiAudio, "loadSoundFile" | "play">
  /** openforge: tells the service of each occurrence; its players then take the sound or the notification. */
  report?: Report
  /** openforge: a reason this TUI raises nothing for a request (not its chat, or a permission it accepts itself). */
  skip?: (request: Pick<AttentionRequest, "kind" | "sessionID">) => Promise<AttentionNotifySkipReason | undefined>
}): AttentionHost {
  let focus: FocusState = "unknown"
  let disposed = false
  const audio = input.audio ?? TuiAudio

  const onFocus = () => {
    focus = "focused"
  }
  const onBlur = () => {
    focus = "blurred"
  }

  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)

  // A file that can't be played plays the built-in sound instead.
  function soundCandidates(kind: Kind, sound: { readonly id?: SoundID; readonly file?: string }) {
    return [sound.file, SOUND_FILES[sound.id ?? kindSounds[kind]]].filter(
      (item, index, list): item is string => typeof item === "string" && list.indexOf(item) === index,
    )
  }

  async function playSound(kind: Kind, sound: { readonly id?: SoundID; readonly file?: string }, volume: number) {
    try {
      for (const file of soundCandidates(kind, sound)) {
        const current = await audio.loadSoundFile(file).catch((error) => {
          console.debug("failed to load attention sound", { file, error })
          return null
        })
        if (disposed) return false
        if (current == null) continue
        if (audio.play(current, { volume }) != null) return true
      }
      return false
    } catch (error) {
      console.debug("failed to play attention sound", { error })
      return false
    }
  }

  async function raise(request: AttentionRequest): Promise<AttentionNotifyResult> {
    try {
      if (!input.config.attention.notifications && !input.config.attention.sound) return skipped("attention_disabled")
      if (disposed || input.renderer.isDestroyed) return skipped("renderer_destroyed")
      const skip = await input.skip?.(request)
      if (skip) return skipped(skip)

      const message = normalizeText(request.message, "", MESSAGE_LIMIT)
      if (!message) return skipped("empty_message")

      const notificationSkip = request.notification === false ? undefined : focusSkip(request.notification, focus)
      const notificationRequested = input.config.attention.notifications && request.notification !== false
      const shouldNotify = notificationRequested && !notificationSkip
      const title = normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT)
      const sound = input.config.attention.sound ? request.sound : false
      const soundSkip = sound === false ? undefined : focusSkip(sound.when, focus)
      const playable = sound !== false && !soundSkip
      // openforge: the service's players (`openforge notify`) play the sound, and with --desktop show the
      // notification, on the machine you sit at; this TUI then doesn't, so nothing comes twice.
      const players = await (input.report?.({
        kind: request.kind,
        sessionID: Schema.is(SessionID)(request.sessionID) ? request.sessionID : undefined,
        title,
        message,
        notify: shouldNotify,
        sound: playable ? { name: request.kind, id: sound.id, file: sound.file } : undefined,
        focused: focus === "focused",
      }) ?? noPlayers)
      const notification =
        shouldNotify && !players.desktop
          ? (() => {
              try {
                return input.renderer.triggerNotification(message, title)
              } catch (error) {
                console.debug("failed to trigger attention notification", { error })
                return false
              }
            })()
          : false
      const played =
        playable && !players.sound
          ? await playSound(request.kind, sound, clampVolume(sound.volume ?? input.config.attention.volume))
          : false
      const forwarded = (shouldNotify && players.desktop) || (playable && players.sound)

      if (!notification && !played && !forwarded) {
        if (notificationRequested && notificationSkip) return skipped(notificationSkip)
        if (soundSkip) return skipped(soundSkip)
      }

      return {
        ok: notification || played || forwarded,
        notification,
        sound: played,
      }
    } catch (error) {
      console.debug("failed to handle attention notification", { error })
      return {
        ok: false,
        notification: false,
        sound: false,
      }
    }
  }

  return {
    notify: (request) => raise(requestOf(request, input.config.attention.sounds)),
    raise,
    settings: () => input.config.attention,
    ours: async (sessionID) => (await input.skip?.({ kind: "default", sessionID })) === undefined,
    dispose() {
      if (disposed) return
      disposed = true
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
    },
  }
}
