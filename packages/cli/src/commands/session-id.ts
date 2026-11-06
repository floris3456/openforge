import { NewSessionID } from "@opencode/schema/session-id"
import { Cause, Exit, Schema } from "effect"
import { Flag } from "effect/cli"

const decode = Schema.decodeUnknownExit(NewSessionID)

/**
 * `--session`'s check: the rule the server's `session.create` applies to a new session's ID (`NewSessionID`), as `-s`
 * creates a session under an ID the server does not know. Its message also shows the value as JSON, where a line
 * break in it can be seen.
 */
export const check = Flag.mapTryCatch(
  (value: string) => {
    const decoded = decode(value)
    if (Exit.isSuccess(decoded)) return decoded.value
    const error = Cause.squash(decoded.cause)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (this one, as JSON: ${JSON.stringify(value)})`,
    )
  },
  (error) => (error instanceof Error ? error.message : String(error)),
)

export * as SessionIDFlag from "./session-id"
