/// <reference path="./audio.d.ts" />
import type {
  Attention,
  AttentionNotifyOptions,
  AttentionNotifyResult,
  AttentionNotifySkipReason,
  AttentionWhen,
  AttentionSoundName,
} from "@opencode/plugin/tui/context"
import { Config } from "./config"
import { Schema } from "effect"
import { Product } from "@opencode/schema/product"
import { SessionID } from "@opencode/schema/session-id"
import stripAnsi from "strip-ansi"
import * as TuiAudio from "./audio"
import {
  defaultSoundPath,
  questionSoundPath,
  permissionSoundPath,
  errorSoundPath,
  subagentDoneSoundPath,
} from "#attention-sounds"
import { noPlayers, type Report } from "./attention-report"

type FocusState = "unknown" | "focused" | "blurred"

type AttentionRenderer = {
  readonly isDestroyed: boolean
  on(event: "focus" | "blur", listener: () => void): unknown
  off(event: "focus" | "blur", listener: () => void): unknown
  triggerNotification(message: string, title?: string): boolean
}

type AttentionHost = Attention & {
  dispose(): void
}

const DEFAULT_TITLE = Product.name
const TITLE_LIMIT = 80
const MESSAGE_LIMIT = 240
export const BUILTIN_SOUNDS: Record<AttentionSoundName, string> = {
  default: defaultSoundPath,
  question: questionSoundPath,
  permission: permissionSoundPath,
  error: errorSoundPath,
  done: defaultSoundPath,
  subagent_done: subagentDoneSoundPath,
}

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

function soundVolume(input: AttentionNotifyOptions, config: Pick<Config.Resolved, "attention">) {
  if (!config.attention.sound) return
  if (input.sound === false) return
  if (input.sound === undefined) return clampVolume(config.attention.volume)
  if (input.sound === true) return clampVolume(config.attention.volume)
  return clampVolume(input.sound.volume ?? config.attention.volume)
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
  skip?: (request: AttentionNotifyOptions) => Promise<AttentionNotifySkipReason | undefined>
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

  function soundCandidates(name: AttentionSoundName) {
    return [input.config.attention.sounds[name], BUILTIN_SOUNDS[name]].filter(
      (item, index, list): item is string => typeof item === "string" && list.indexOf(item) === index,
    )
  }

  async function playSound(name: AttentionSoundName, volume: number) {
    try {
      for (const file of soundCandidates(name)) {
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

  return {
    async notify(request) {
      try {
        if (!input.config.attention.notifications && !input.config.attention.sound) return skipped("attention_disabled")
        if (disposed || input.renderer.isDestroyed) return skipped("renderer_destroyed")
        const skip = await input.skip?.(request)
        if (skip) return skipped(skip)

        const message = normalizeText(request.message, "", MESSAGE_LIMIT)
        if (!message) return skipped("empty_message")

        const requestedNotification = typeof request.notification === "object" ? request.notification : undefined
        const notificationSkip = focusSkip(requestedNotification?.when ?? "blurred", focus)
        const notificationRequested = input.config.attention.notifications && request.notification !== false
        const shouldNotify = notificationRequested && !notificationSkip
        const title = normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT)
        const volume = soundVolume(request, input.config)
        const requestedSound = typeof request.sound === "object" ? request.sound : undefined
        const soundSkip = volume === undefined ? undefined : focusSkip(requestedSound?.when ?? "always", focus)
        const soundName =
          requestedSound?.name && Schema.is(Config.AttentionSoundName)(requestedSound.name)
            ? requestedSound.name
            : "default"
        const playable = volume !== undefined && !soundSkip
        // openforge: the service's players (`openforge notify`) play the sound, and with --desktop show the
        // notification, on the machine you sit at; this TUI then doesn't, so nothing comes twice.
        const players = await (input.report?.({
          kind: soundName,
          sessionID: Schema.is(SessionID)(request.sessionID) ? request.sessionID : undefined,
          title,
          message,
          notify: shouldNotify,
          sound: playable ? { name: soundName, file: input.config.attention.sounds[soundName] } : undefined,
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
        const sound = playable && !players.sound ? await playSound(soundName, volume) : false
        const forwarded = (shouldNotify && players.desktop) || (playable && players.sound)

        if (!notification && !sound && !forwarded) {
          if (notificationRequested && notificationSkip) return skipped(notificationSkip)
          if (soundSkip) return skipped(soundSkip)
        }

        return {
          ok: notification || sound || forwarded,
          notification,
          sound,
        }
      } catch (error) {
        console.debug("failed to handle attention notification", { error })
        return {
          ok: false,
          notification: false,
          sound: false,
        }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
    },
  }
}
