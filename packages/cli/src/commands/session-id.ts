import { Flag } from "effect/cli"

/**
 * `--session`'s check. The server creates a session under an ID it does not know, and every model request of that
 * session carries the ID in a header, which fetch refuses to send with a line break in it, so each request would fail.
 * An ID the server makes (`ses_` and 26 letters and digits) passes, and so does one of a user's own of letters,
 * digits and ASCII punctuation.
 */
export const check = Flag.mapTryCatch(
  (value: string) => {
    if (/^ses[\x21-\x7e]*$/.test(value)) return value
    throw new Error(
      `Expected a session ID: "ses" and then letters, digits or ASCII punctuation, without spaces, line breaks, other control characters or characters outside ASCII (this one, as JSON: ${JSON.stringify(value)})`,
    )
  },
  (error) => (error instanceof Error ? error.message : String(error)),
)

export * as SessionIDFlag from "./session-id"
