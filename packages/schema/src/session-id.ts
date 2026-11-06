import { Schema } from "effect"
import { descending } from "./identifier.js"
import { statics } from "./schema.js"

export const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(
  Schema.brand("SessionID"),
  Schema.annotate({ identifier: "Session.ID" }),
  statics((schema) => ({
    create: () => schema.make("ses_" + descending()),
  })),
)
export type SessionID = typeof SessionID.Type

/**
 * The ID a caller gives a new session (the server's `session.create`, the CLI's `--session`): "ses" and then letters,
 * digits or ASCII punctuation, as every ID the server makes is. Every model request of a session carries its ID in a
 * header, which fetch refuses to send with a line break in it. Only a new session's ID is checked; a stored session's
 * is read as a SessionID.
 */
export const NewSessionID = SessionID.check(
  Schema.isPattern(/^ses[\x21-\x7e]*$/u, {
    identifier: "Session.NewID",
    expected:
      'a session ID: "ses" and then letters, digits or ASCII punctuation, without spaces, line breaks, other control characters or characters outside ASCII',
  }),
)
