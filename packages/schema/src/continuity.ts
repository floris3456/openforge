export * as Continuity from "./continuity.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"
import { SessionID } from "./session-id.js"

/** Work a pause waits for: a step that has not reached a boundary, a running tool or a model call. */
export const Work = Schema.Struct({
  sessionID: SessionID.pipe(optional),
  kind: Schema.Literals(["step", "tool", "model"]),
  name: Schema.String,
}).annotate({ identifier: "Continuity.Work" })
export type Work = typeof Work.Type

export const State = Schema.Literals(["running", "pausing", "paused"]).annotate({ identifier: "Continuity.State" })
export type State = typeof State.Type

export const Status = Schema.Struct({
  state: State,
  /** The service started paused; writes are refused until it is resumed. */
  startedPaused: Schema.Boolean,
  /** When a pause in progress gives up, in epoch milliseconds. */
  deadline: Schema.Finite.pipe(optional),
  /** What a pause in progress still waits for. */
  waiting: Schema.Array(Work),
  /** Sessions with an execution that rests at a step boundary or in a wait that survives a stop. */
  rested: Schema.Array(SessionID),
  /** Sessions with an execution in this process. */
  active: Schema.Array(SessionID),
}).annotate({ identifier: "Continuity.Status" })
export type Status = typeof Status.Type

export const PauseResult = Schema.Union([
  Schema.Struct({ paused: Schema.Literal(true), rested: Schema.Array(SessionID) }),
  Schema.Struct({ paused: Schema.Literal(false), waiting: Schema.Array(Work) }),
]).annotate({ identifier: "Continuity.PauseResult" })
export type PauseResult = typeof PauseResult.Type

const Pausing = ephemeral({
  type: "service.pausing",
  schema: { deadline: Schema.Finite, waiting: Schema.Array(Work) },
})
const Paused = ephemeral({ type: "service.paused", schema: { rested: Schema.Array(SessionID) } })
const Expired = ephemeral({ type: "service.pause.expired", schema: { waiting: Schema.Array(Work) } })
const Resumed = ephemeral({ type: "service.resumed", schema: {} })

export const Event = {
  Pausing,
  Paused,
  Expired,
  Resumed,
  Definitions: inventory(Pausing, Paused, Expired, Resumed),
}
