// Writes that a release switch must not lose. While the service switches it cannot be reached for a moment, and
// the new release refuses writes with 503 until it is resumed ("switching, try again in 1 s"), so that a rollback
// cannot lose one. A prompt, a form answer and a permission reply each carry an id the service already knows or
// that the client chose, and the service ignores a duplicate, so they are sent again with the same id until the
// service takes them.
import { ClientError } from "./promise/generated/client-error.js"

/** How long a write is resent before it is reported. */
export const limit = 120_000

/** Reported when the service did not take a write within the resend limit. */
export class ResendTimeoutError extends Error {
  override readonly name = "ResendTimeoutError"
  constructor(options?: ErrorOptions) {
    super("openforge did not take it within 2 minutes; it was switching releases or could not be reached", options)
  }
}

export type ResendOptions = {
  /**
   * Resolves once another attempt is worthwhile, for example when the event stream reaches a service again. Without
   * it, the next attempt follows the service's own advice and waits 1 s.
   */
  readonly ready?: (error: unknown, signal?: AbortSignal) => Promise<void>
  readonly signal?: AbortSignal
  /** Called once, when the first attempt failed in a way worth resending. */
  readonly onResend?: () => void
  /** Milliseconds; 2 minutes unless a test shortens it. */
  readonly limit?: number
}

/** Runs `send` until the service takes it, resending after a connection error or a 503. */
export async function resend<A>(send: () => Promise<A>, options: ResendOptions = {}): Promise<A> {
  const deadline = Date.now() + (options.limit ?? limit)
  const ready = options.ready ?? ((_error, signal) => delay(1_000, signal))
  let resending = false
  while (true) {
    try {
      return await send()
    } catch (error) {
      if (!resendable(error) || options.signal?.aborted) throw error
      if (Date.now() >= deadline) throw new ResendTimeoutError({ cause: error })
      if (!resending) options.onResend?.()
      resending = true
      await within(ready(error, options.signal), deadline - Date.now())
    }
  }
}

/**
 * Whether a failed write may be sent again: the service could not be reached, or it is switching, starting or
 * stopping. An error that wraps such a failure (as its `cause`) counts too; one that already gave up does not.
 */
export function resendable(error: unknown): boolean {
  if (error instanceof ResendTimeoutError) return false
  if (error instanceof ClientError) {
    if (error.reason === "Transport") return !(error.cause instanceof Error && error.cause.name === "AbortError")
    return error.reason === "UnexpectedStatus" && status(error.cause) === 503
  }
  if (error instanceof Error && error.cause !== undefined && resendable(error.cause)) return true
  // A 503 an endpoint declares arrives as the service's own error body.
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "service_switching" || error.code === "service_starting" || error.code === "service_stopping")
  )
}

/** Whether the service could not be reached at all, rather than answering that it is switching. */
export function unreachable(error: unknown) {
  return error instanceof ClientError && error.reason === "Transport"
}

export function isResendTimeoutError(error: unknown): error is ResendTimeoutError {
  return error instanceof ResendTimeoutError
}

function status(cause: unknown) {
  return typeof cause === "object" && cause !== null && "status" in cause ? cause.status : undefined
}

async function within(wait: Promise<void>, milliseconds: number) {
  const stop = new AbortController()
  await Promise.race([wait, delay(Math.max(0, milliseconds), stop.signal)])
  stop.abort()
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds)
    signal?.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
  })
}
