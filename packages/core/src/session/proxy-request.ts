export * as SessionProxyRequest from "./proxy-request.js"

import type { HttpMiddleware } from "@opencode/ai/route"
import { Effect } from "effect"

// CLIProxyPacer names the request behind each model answer in `X-CPA-Trace-Id`, as
// `<yyyymmddhhmmss>-<account>-<request ID>` (its `dispatch::Trace::selected`). The request ID, a UUID, is what its
// request records (`requests.ext`) and stored prompts go by. A request it refuses before choosing an account has none.
const TRACE = /^\d{14}-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** The request ID in an `X-CPA-Trace-Id` value; undefined for anything else. */
export function requestID(trace: string | undefined) {
  if (trace === undefined) return undefined
  return TRACE.exec(trace)?.[1]?.toLowerCase()
}

/**
 * HTTP middleware that keeps the request ID of the latest answer, around `inner` when there is one, so the answer
 * seen is the provider's own and not one a hook rewrote. It reads one header and leaves the request and its body as
 * they are.
 */
export function capture(inner: HttpMiddleware | undefined) {
  const seen: { id?: string } = {}
  const http: HttpMiddleware = (request, handler) => {
    const read: typeof handler = (sent) =>
      handler(sent).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            seen.id = requestID(response.headers["x-cpa-trace-id"])
          }),
        ),
      )
    return inner ? inner(request, read) : read(request)
  }
  return { http, current: () => seen.id }
}
