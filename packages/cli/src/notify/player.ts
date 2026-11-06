export * as Player from "./player"

import type { Attention } from "@opencode/schema/attention"
import { errorMessage } from "../util/error"

// What `openforge notify` does with each occurrence a service's TUIs report: play its sound here and, with --desktop,
// show it as a desktop notification here.

/**
 * The same occurrence reported again within this time (two TUIs on the same chat) plays once. Its desktop notification
 * waits for the end of it, so a copy from a TUI whose window is focused can still suppress it.
 */
export const SAME_MS = 300

export interface Deps {
  /** Plays a sound; rejects with why it can't. */
  readonly play: (sound: Attention.Sound) => Promise<string>
  /** Shows a desktop notification; absent without --desktop. */
  readonly show?: (title: string, message: string) => Promise<void>
  /** What always shows: a test's outcome, each distinct failure once. */
  readonly log: (line: string) => void
  /** Every occurrence and what was done with it (--verbose). */
  readonly debug: (line: string) => void
  readonly wait?: (ms: number, then: () => void) => void
}

export function create(deps: Deps) {
  const wait = deps.wait ?? ((ms, then) => void setTimeout(then, ms))
  const recent = new Map<string, { notify: boolean; focused: boolean; sounded: boolean }>()
  const warned = new Set<string>()
  const warn = (line: string) => {
    if (warned.has(line)) return
    warned.add(line)
    deps.log(line)
  }

  const sound = (occurrence: Attention.Occurrence, label: string, test: boolean) => {
    const requested = occurrence.sound
    if (requested === undefined) return
    void deps.play(requested).then(
      (played) => (test ? deps.log : deps.debug)(`${label}: played ${played}`),
      (error: unknown) => {
        deps.debug(`${label}: sound ${requested.name} did not play: ${errorMessage(error)}`)
        warn(`Sound ${requested.name} did not play: ${errorMessage(error)}`)
      },
    )
  }

  const desktop = (
    occurrence: Attention.Occurrence,
    merged: { notify: boolean; focused: boolean },
    label: string,
    test: boolean,
  ) => {
    const show = deps.show
    if (show === undefined) return
    if (!merged.notify) return deps.debug(`${label}: no desktop notification, the TUI shows none for it`)
    if (merged.focused) return deps.debug(`${label}: no desktop notification, a TUI showing it was focused`)
    void show(occurrence.title, occurrence.message).then(
      () => (test ? deps.log : deps.debug)(`${label}: desktop notification shown`),
      (error: unknown) => {
        deps.debug(`${label}: desktop notification failed: ${errorMessage(error)}`)
        warn(`Desktop notification failed: ${errorMessage(error)}`)
      },
    )
  }

  return {
    receive(occurrence: Attention.Occurrence, test = false) {
      const label = `${test ? "test " : ""}${occurrence.kind} "${occurrence.title}": ${occurrence.message}`
      const key = JSON.stringify([occurrence.kind, occurrence.sessionID ?? null, occurrence.message])
      const known = recent.get(key)
      if (known !== undefined) {
        deps.debug(`${label}: the same occurrence again within ${SAME_MS} ms (focused: ${occurrence.focused})`)
        known.notify ||= occurrence.notify
        known.focused ||= occurrence.focused
        if (known.sounded || occurrence.sound === undefined) return
        known.sounded = true
        return sound(occurrence, label, test)
      }
      const merged = { notify: occurrence.notify, focused: occurrence.focused, sounded: occurrence.sound !== undefined }
      recent.set(key, merged)
      deps.debug(`${label}: received (notify: ${occurrence.notify}, focused: ${occurrence.focused})`)
      if (test) deps.log(`Test ${occurrence.kind} arrived.`)
      sound(occurrence, label, test)
      wait(SAME_MS, () => {
        recent.delete(key)
        desktop(occurrence, merged, label, test)
      })
    },
  }
}
