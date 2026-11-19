export * as CodeModePins from "./pins.js"

import type { Entry } from "@opencode/schema/config"

/** A tool always (true) or never (false) listed in Code Mode's catalog, by its catalog path or namespace (`ns.*`). */
export type Pins = Readonly<Record<string, boolean>>

/** A session's pin of one tool, and the file that sets it; none for a pin set without a file. */
export interface Sourced {
  readonly pinned: boolean
  readonly from?: string
}

/** Every config document's `codemode.pinned`, lowest priority first: a project's add to the person's, a later value
 *  winning per tool. */
export const merged = (entries: ReadonlyArray<Entry>): Pins =>
  entries.reduce<Record<string, boolean>>(
    (pins, entry) => (entry.type === "document" ? Object.assign(pins, entry.info.codemode?.pinned) : pins),
    {},
  )

/** A session's pins: the config's ({@link merged}) with its agent's (`agents.<name>.codemode.pinned`) laid over them,
 *  the agent's value winning per tool. */
export const forAgent = (
  entries: ReadonlyArray<Entry>,
  agent: { readonly codemode?: { readonly pinned?: Pins } },
): Pins => ({ ...merged(entries), ...agent.codemode?.pinned })

/**
 * {@link forAgent}'s pins, each with the file that sets it: a config pin's document, and an agent's own pin the last of
 * `documents` that sets it (the config documents and agent files its agents were loaded from, `ConfigAgentSources`).
 */
export const sourced = (
  entries: ReadonlyArray<Entry>,
  agent: { readonly id: string; readonly codemode?: { readonly pinned?: Pins } },
  documents: ReadonlyArray<Entry>,
): Readonly<Record<string, Sourced>> =>
  Object.fromEntries([
    ...entries.flatMap((entry) =>
      entry.type === "document"
        ? Object.entries(entry.info.codemode?.pinned ?? {}).map(([tool, pinned]) => [tool, pin(pinned, entry.path)])
        : [],
    ),
    ...Object.entries(agent.codemode?.pinned ?? {}).map(([tool, pinned]) => [
      tool,
      pin(
        pinned,
        documents.findLast(
          (entry) => entry.type === "document" && entry.info.agents?.[agent.id]?.codemode?.pinned?.[tool] !== undefined,
        )?.path,
      ),
    ]),
  ])

const pin = (pinned: boolean, from: string | undefined): Sourced => (from === undefined ? { pinned } : { pinned, from })
