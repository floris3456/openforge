// What openforge's release switch reports while it runs, and how the CLI and the TUI put that in words.
import { Product } from "@opencode/schema/product"
import type { ContinuityWork } from "./promise/generated/types.js"

/** Work a release switch waits for, with the title of its chat once the switch has read it. */
export type SwitchWork = ContinuityWork & { readonly title?: string }

/**
 * What an upgrade in progress reports, in order: installing, switching (again with what the pause still waits for, as
 * that changes), waiting (only when the switch has to try again later), then switched or failed.
 */
export type UpgradeState =
  | { readonly type: "available"; readonly version: string }
  | { readonly type: "installing"; readonly version: string }
  | { readonly type: "switching"; readonly version: string; readonly waiting?: ReadonlyArray<SwitchWork> }
  /**
   * Installed, not switched yet. `expired` when the running service's pause gave up after `limit` milliseconds while
   * `waiting` still ran: the switch tries again once that has finished. Without it the running service cannot pause,
   * and the switch waits until no chat is running.
   */
  | {
      readonly type: "waiting"
      readonly version: string
      readonly expired?: { readonly limit: number; readonly waiting: ReadonlyArray<SwitchWork> }
    }
  | { readonly type: "switched"; readonly version: string }
  | { readonly type: "failed"; readonly version?: string; readonly message: string }

/** How an upgrade ended, when it did not fail. */
export type UpgradeOutcome =
  | { readonly type: "current"; readonly version: string }
  | { readonly type: "unavailable"; readonly message: string }
  | { readonly type: "switched"; readonly from: string; readonly to: string }

/** A chat's title, when the caller knows it. */
export type TitleOf = (sessionID: string) => string | undefined

/**
 * What a release switch waits for, in words: `a reply in "Fix the tests", webfetch in "Docs"`. A chat's model call is
 * its reply, so a chat in the middle of one is named once. A chat is named by the title the switch read, else by
 * `title`; one without a title is "an untitled chat".
 */
export function describeWork(waiting: ReadonlyArray<SwitchWork>, title?: TitleOf) {
  if (waiting.length === 0) return "the work that was still running"
  const seen = new Set<string>()
  return waiting
    .flatMap((work) => {
      const what =
        work.kind === "tool"
          ? work.name
          : work.kind === "step" && work.name !== "reply"
            ? "a step"
            : work.sessionID
              ? "a reply"
              : "a model call"
      const key = `${work.sessionID ?? ""} ${what}`
      if (seen.has(key)) return []
      seen.add(key)
      if (!work.sessionID) return [what]
      const name = work.title ?? title?.(work.sessionID)
      return [`${what} in ${name ? `"${name}"` : "an untitled chat"}`]
    })
    .join(", ")
}

/** `Switching to openforge 0.1.1; waiting for webfetch in "Docs"`. Without a version, a switch another screen runs. */
export function switchingMessage(version?: string, waiting?: ReadonlyArray<SwitchWork>, title?: TitleOf) {
  const switching = version ? `Switching to ${Product.name} ${version}` : `Switching to a new ${Product.name} release`
  return waiting?.length ? `${switching}; waiting for ${describeWork(waiting, title)}` : switching
}

/** Why an installed release is not in use yet, and when it will be. */
export function waitingMessage(state: Extract<UpgradeState, { type: "waiting" }>, title?: TitleOf) {
  const installed = `${Product.name} ${state.version} is installed.`
  if (!state.expired) return `${installed} The running service cannot pause; it switches once no chat is running.`
  return `${installed} The chats did not pause within ${spokenDuration(state.expired.limit)}; it switches once this has finished: ${describeWork(state.expired.waiting, title)}.`
}

/** `2 minutes`, `5 seconds`, `1.5 seconds`, `300 ms`. */
export function spokenDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds} ms`
  const [count, unit] =
    milliseconds % 60_000 === 0
      ? [milliseconds / 60_000, "minute"]
      : [Number((milliseconds / 1_000).toFixed(1)), "second"]
  return `${count} ${unit}${count === 1 ? "" : "s"}`
}
