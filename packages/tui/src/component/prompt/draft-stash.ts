import type { WidthMethod } from "@opentui/core"
import { appendPrompt, parsePromptInfo, type PromptInfo } from "../../prompt/history"
import type { PromptRef } from "./index"

// Holds one in-progress draft per tab across Prompt remounts. A draft is
// consumed on take: restoring it moves it out of the stash, so a stale copy
// never shadows newer input.
export type DraftEntry = { prompt: PromptInfo; cursor: number }

const byTab = new Map<string | undefined, DraftEntry>()

export function takeDraft(sessionID: string | undefined) {
  const entry = byTab.get(sessionID)
  byTab.delete(sessionID)
  return entry
}

export function saveDraft(sessionID: string | undefined, entry: DraftEntry) {
  byTab.set(sessionID, entry)
}

/** A tab's draft as it outlives the process: no `sessionID` for the home screen's composer. */
export type CarriedDraft = { readonly sessionID?: string; readonly prompt: PromptInfo; readonly cursor: number | null }

/**
 * Every stashed draft, for this screen to carry over when it restarts on a new release. Composers stash what they
 * hold when they close, so read this once the screen has closed.
 */
export function stashedDrafts(): CarriedDraft[] {
  return Array.from(byTab, ([sessionID, entry]) => ({
    ...(sessionID === undefined ? {} : { sessionID }),
    prompt: entry.prompt,
    // JSON has no Infinity, which means "at the end".
    cursor: Number.isFinite(entry.cursor) ? entry.cursor : null,
  })).filter((draft) => draft.prompt.text !== "")
}

/** Stashes drafts carried over from before a restart, for their composers to take when they mount. */
export function stashDrafts(drafts: unknown) {
  if (!Array.isArray(drafts)) return
  for (const draft of drafts) {
    if (!draft || typeof draft !== "object") continue
    const sessionID = "sessionID" in draft && typeof draft.sessionID === "string" ? draft.sessionID : undefined
    const prompt = "prompt" in draft ? parsePromptInfo(draft.prompt) : undefined
    if (!prompt?.text) continue
    const cursor = "cursor" in draft && typeof draft.cursor === "number" ? draft.cursor : Infinity
    byTab.set(sessionID, { prompt, cursor })
  }
}

const composers = new Map<string | undefined, PromptRef>()

/** Marks a tab's mounted composer as the one {@link appendToSessionPrompt} writes to; returns its unregister. */
export function registerComposer(sessionID: string | undefined, composer: PromptRef) {
  composers.set(sessionID, composer)
  return () => {
    if (composers.get(sessionID) === composer) composers.delete(sessionID)
  }
}

/**
 * Appends a prompt that comes back after an await (an undo or revert) to a session's composer if one is mounted, else
 * to its stashed draft, after anything already typed there. A session view remounts with its tab, so the composer it
 * started with may be gone by then. Returns the composer it wrote to.
 */
export function appendToSessionPrompt(sessionID: string, prompt: PromptInfo, widthMethod: WidthMethod) {
  const composer = composers.get(sessionID)
  if (!composer) {
    const draft = takeDraft(sessionID)?.prompt
    saveDraft(sessionID, { prompt: draft ? appendPrompt(draft, prompt, widthMethod) : prompt, cursor: Infinity })
    return
  }
  composer.setMode("normal")
  composer.set(appendPrompt(composer.current, prompt, widthMethod))
  return composer
}
