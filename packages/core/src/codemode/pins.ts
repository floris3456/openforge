export * as CodeModePins from "./pins.js"

import type { Entry } from "@opencode/schema/config"

/** A tool always (true) or never (false) listed in Code Mode's catalog, by its catalog path or namespace (`ns.*`). */
export type Pins = Readonly<Record<string, boolean>>

/** Every config document's `codemode.pinned`, lowest priority first: a project's add to the person's, a later value
 *  winning per tool. */
export const merged = (entries: ReadonlyArray<Entry>): Pins =>
  entries.reduce<Record<string, boolean>>(
    (pins, entry) => (entry.type === "document" ? Object.assign(pins, entry.info.codemode?.pinned) : pins),
    {},
  )
