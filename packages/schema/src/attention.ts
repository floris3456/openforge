export * as Attention from "./attention.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { SessionID } from "./session-id.js"

// A notification a TUI shows (a chat done, a question, a permission, an error), as it tells its service, and what the
// service passes on to the sound players that follow it (`openforge notify`). Nothing of it is stored.

/** What happened; each kind has its own built-in sound, named the same. */
export const Kind = Schema.Literals(["done", "subagent_done", "question", "permission", "error", "default"]).annotate({
  identifier: "Attention.Kind",
})
export type Kind = typeof Kind.Type

/** The kinds a player can ask a test occurrence of. */
export const testKinds = ["done", "subagent_done", "question", "permission", "error"] as const satisfies readonly Kind[]

/** A sound: a built-in one by name, or a sound file named in the TUI's settings on the service's machine. */
export interface Sound extends Schema.Schema.Type<typeof Sound> {}
export const Sound = Schema.Struct({
  name: Kind,
  /** A file instead of the built-in sound; a player that can't get it plays the built-in one. */
  file: Schema.String.check(Schema.isMaxLength(4096)).pipe(optional),
}).annotate({ identifier: "Attention.Sound" })

/** One notification as a TUI decided it. */
export interface Occurrence extends Schema.Schema.Type<typeof Occurrence> {}
export const Occurrence = Schema.Struct({
  kind: Kind,
  /** The chat it is about. */
  sessionID: SessionID.pipe(optional),
  title: Schema.String.check(Schema.isMaxLength(400)),
  message: Schema.String.check(Schema.isMaxLength(1000)),
  /** The TUI shows a desktop notification for it, unless its window is focused. */
  notify: Schema.Boolean,
  /** The sound the TUI plays for it; absent when it plays none. */
  sound: Sound.pipe(optional),
  /** The TUI's window was focused. Unknown focus counts as not focused. */
  focused: Schema.Boolean,
}).annotate({ identifier: "Attention.Occurrence" })

/** The players connected to a service when it got an occurrence, which the TUI leaves the sound or the notification to. */
export interface Players extends Schema.Schema.Type<typeof Players> {}
export const Players = Schema.Struct({
  /** A player is connected: it plays the sound. */
  sound: Schema.Boolean,
  /** A player that shows desktop notifications (`--desktop`) is connected. */
  desktop: Schema.Boolean,
}).annotate({ identifier: "Attention.Players" })

/** What a service sends a player that follows it: first `following`, then every occurrence its TUIs report. */
export const FollowEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("following"),
    /** The service's version. */
    version: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("occurrence"),
    occurrence: Occurrence,
    /** A test a player asked for (`openforge notify --test`). */
    test: Schema.Literal(true).pipe(optional),
  }),
]).annotate({ identifier: "Attention.FollowEvent" })
export type FollowEvent = typeof FollowEvent.Type
