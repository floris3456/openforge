export * as AutoUpdate from "./auto-update.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"

// openforge's automatic updates (spec auto-update): with Settings › Updates "Automatic updates" on, the background
// service checks for a new release when it starts and every 15 minutes, and switches to it as `openforge upgrade`
// does. The setting is the `update` key of the service's global config: on is `auto`, off anything else.

/** An automatic update that failed and was rolled back; that release is not tried again on its own. */
export interface Failure extends Schema.Schema.Type<typeof Failure> {}
export const Failure = Schema.Struct({
  /** The release it tried to switch to. */
  version: Schema.String,
  /** Why it failed. */
  message: Schema.String,
  /** When, in milliseconds since the Unix epoch on the service's clock. */
  at: Schema.Finite,
}).annotate({ identifier: "AutoUpdate.Failure" })

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  /** Whether automatic updates are on: the global config's `update` is `auto`. */
  enabled: Schema.Boolean,
  /** Why this service can't update itself, such as a source checkout; it then checks nothing. */
  unavailable: Schema.String.pipe(optional),
  /** The last automatic update that failed. */
  failure: Failure.pipe(optional),
}).annotate({ identifier: "AutoUpdate.Status" })

export const Update = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({ identifier: "AutoUpdate.Update" })

/** An automatic update failed and was rolled back; each attached TUI says so once. */
const Failed = ephemeral({ type: "installation.update-failed", schema: { failure: Failure } })

export const Event = {
  Failed,
  Definitions: inventory(Failed),
}
