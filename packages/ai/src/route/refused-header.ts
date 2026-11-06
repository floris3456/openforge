import type { Headers } from "effect/http"
import { AIError, InvalidRequestError } from "../schema/index.js"

// Fetch and WebSocket strip spaces, tabs, CRs and LFs around a header value, then refuse one that still holds a NUL, a
// CR or an LF, or a character above U+00FF, before they send anything (Bun: "Header '<name>' has invalid value").
const refused = (value: string) => /[\0\r\n]|[^\0-\xff]/.test(value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ""))

/**
 * How a request whose sending failed fails, when one of its header values is one fetch and WebSocket refuse: as an
 * invalid request, which no retry repeats, since the same request fails the same way on every attempt. Undefined when
 * every value can be sent.
 */
export const refusedHeader = (headers: Headers.Headers, cause: unknown) => {
  const name = Object.keys(headers).find((key) => refused(headers[key] ?? ""))
  if (name === undefined) return undefined
  return new AIError({
    reason: new InvalidRequestError({
      message: `Request not sent: header '${name}' has a line break, a NUL or a character above U+00FF in its value`,
      cause,
    }),
  })
}
