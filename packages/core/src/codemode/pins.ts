export * as CodeModePins from "./pins.js"

import type { Entry } from "@opencode/schema/config"
import type { Agent } from "@opencode/schema/agent"

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

/** {@link forAgent}'s pins, each with the file that sets it: its config document's, or the agent's own `from`. */
export const sourced = (
  entries: ReadonlyArray<Entry>,
  agent: { readonly codemode?: Agent.Info["codemode"] },
): Readonly<Record<string, Sourced>> =>
  Object.fromEntries([
    ...entries.flatMap((entry) =>
      entry.type === "document"
        ? Object.entries(entry.info.codemode?.pinned ?? {}).map(([tool, pinned]) => [tool, pin(pinned, entry.path)])
        : [],
    ),
    ...Object.entries(agent.codemode?.pinned ?? {}).map(([tool, pinned]) => [
      tool,
      pin(pinned, agent.codemode?.from?.[tool]),
    ]),
  ])

/** An agent's pins with a document's `pinned` laid over them, each of those set by the document's file, if it has one. */
export const lay = (
  codemode: Agent.Info["codemode"],
  pinned: Pins,
  path: Entry["path"],
): NonNullable<Agent.Info["codemode"]> => {
  const from = Object.fromEntries([
    ...Object.entries(codemode?.from ?? {}).filter(([tool]) => !(tool in pinned)),
    ...(path === undefined ? [] : Object.keys(pinned).map((tool) => [tool, path] as const)),
  ])
  return {
    pinned: { ...codemode?.pinned, ...pinned },
    ...(Object.keys(from).length === 0 ? {} : { from }),
  }
}

const pin = (pinned: boolean, from: string | undefined): Sourced => (from === undefined ? { pinned } : { pinned, from })
