export * as Attention from "./attention.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { SessionID } from "./session-id.js"

// A notification a TUI shows (a chat done, a question, a permission, an error), as it tells its service, and what the
// service passes on to the sound players that follow it (`openforge notify`). Nothing of it is stored.

/** What happened; each kind has a built-in sound of its own (`kindSounds`). */
export const Kind = Schema.Literals([
  "done",
  "reply",
  "subagent_done",
  "question",
  "permission",
  "error",
  "default",
]).annotate({
  identifier: "Attention.Kind",
})
export type Kind = typeof Kind.Type

/** The kinds a player can ask a test occurrence of. */
export const testKinds = [
  "done",
  "reply",
  "subagent_done",
  "question",
  "permission",
  "error",
] as const satisfies readonly Kind[]
export type TestKind = (typeof testKinds)[number]

/** The built-in sounds every install has, by their file names (`packages/ui/src/assets/audio/<id>.mp3`). */
export const sounds = [
  "alert-01",
  "alert-02",
  "alert-03",
  "alert-04",
  "alert-05",
  "alert-06",
  "alert-07",
  "alert-08",
  "alert-09",
  "alert-10",
  "bip-bop-01",
  "bip-bop-02",
  "bip-bop-03",
  "bip-bop-04",
  "bip-bop-05",
  "bip-bop-06",
  "bip-bop-07",
  "bip-bop-08",
  "bip-bop-09",
  "bip-bop-10",
  "nope-01",
  "nope-02",
  "nope-03",
  "nope-04",
  "nope-05",
  "nope-06",
  "nope-07",
  "nope-08",
  "nope-09",
  "nope-10",
  "nope-11",
  "nope-12",
  "staplebops-01",
  "staplebops-02",
  "staplebops-03",
  "staplebops-04",
  "staplebops-05",
  "staplebops-06",
  "staplebops-07",
  "yup-01",
  "yup-02",
  "yup-03",
  "yup-04",
  "yup-05",
  "yup-06",
] as const
export const SoundID = Schema.Literals(sounds).annotate({ identifier: "Attention.SoundID" })
export type SoundID = typeof SoundID.Type

/** The sound a kind plays when it names no other. */
export const kindSounds: Record<Kind, SoundID> = {
  done: "bip-bop-01",
  reply: "bip-bop-01",
  default: "bip-bop-01",
  subagent_done: "yup-01",
  question: "bip-bop-03",
  permission: "bip-bop-03",
  error: "nope-03",
}

/**
 * A sound: a sound file named in the TUI's settings on the service's machine, else a built-in one by its ID, else the
 * kind's built-in sound. A player that knows no `id` (before notifications step 2) plays the kind's.
 */
export interface Sound extends Schema.Schema.Type<typeof Sound> {}
export const Sound = Schema.Struct({
  name: Kind,
  /** A built-in sound instead of the kind's. */
  id: SoundID.pipe(optional),
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
