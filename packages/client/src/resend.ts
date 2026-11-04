// Writes that a release switch must not lose. While the service switches it cannot be reached for a moment, and
// the new release refuses writes with 503 until it is resumed ("switching, try again in 1 s"), so that a rollback
// cannot lose one. Neither kind of failure reached the service, so any write is sent again until the service takes
// it, for up to 2 minutes. A connection that drops after the request went out is different: the old service may have
// taken it just before it stopped. Only a write the service may get twice and end up the same is resent then: one
// that sets something, settles a request by its id, or carries an id the service ignores when it sees it again.
//
// `createResender` does this for every write a client sends, in its `fetch`; `resend` does it for one call.
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
  if (isResendTimeoutError(error)) return false
  if (error instanceof ClientError) {
    if (error.reason === "Transport") return !(error.cause instanceof Error && error.cause.name === "AbortError")
    return error.reason === "UnexpectedStatus" && status(error.cause) === 503
  }
  if (error instanceof Error && error.cause !== undefined && resendable(error.cause)) return true
  // A 503 an endpoint declares arrives as the service's own error body.
  return typeof error === "object" && error !== null && "code" in error && switching(error.code)
}

/** Whether the service could not be reached at all, rather than answering that it is switching. */
export function unreachable(error: unknown) {
  return error instanceof ClientError && error.reason === "Transport"
}

/** Whether a write was given up after the resend limit, also when another error wraps that. */
export function isResendTimeoutError(error: unknown): error is Error {
  return causes(error).some((cause) => cause instanceof ResendTimeoutError)
}

/** Whether the connection was refused, so the request never reached a service. */
export function refused(error: unknown) {
  return causes(error).some(
    (cause) =>
      (typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        (cause.code === "ECONNREFUSED" || cause.code === "ConnectionRefused")) ||
      (cause instanceof Error && /\bECONNREFUSED\b/.test(cause.message)),
  )
}

/**
 * Writes the service may get twice and end up the same. PUT, PATCH and DELETE set and remove; the POSTs are listed:
 * they set a selection or boundary, settle a request named in the path, or carry an `id` the service keeps and ignores
 * when it sees it again (only with that `id`). Matched on the end of the path, so a base URL with a path prefix works
 * too.
 */
const repeatable: ReadonlyArray<{ readonly path: RegExp; readonly id?: true }> = [
  { path: /\/api\/session$/, id: true },
  { path: /\/api\/session\/[^/]+\/(prompt|synthetic|shell|command|compact)$/, id: true },
  { path: /\/api\/session\/[^/]+\/(agent|model|view|revert\/stage|revert\/commit)$/ },
  { path: /\/api\/session\/[^/]+\/(form|permission)\/[^/]+\/reply$/ },
]

/** Whether a write may be resent after a connection that dropped once the request went out. */
export function repeats(request: { readonly method: string; readonly path: string; readonly body?: unknown }) {
  const method = request.method.toUpperCase()
  if (method === "PUT" || method === "PATCH" || method === "DELETE") return true
  if (method !== "POST") return false
  return repeatable.some((rule) => rule.path.test(request.path) && (!rule.id || carriesID(request.body)))
}

export type Resender = ReturnType<typeof createResender>

/**
 * Resends every write sent through the `fetch` it wraps, as described above, so a client needs no resend of its own
 * per call. `wake` makes waiting writes try again at once: call it when the event stream reaches a service again and
 * when the service resumes. `pending` counts the writes waiting to be resent; `unanswered` counts every write the
 * service has not answered yet, from its first attempt on, so a client that is about to go away (a TUI restarting on
 * a new release) can wait for a write that is still on its way.
 */
export function createResender(options: { readonly limit?: number } = {}) {
  const wakers = new Set<() => void>()
  const listeners = new Set<(pending: number) => void>()
  const watchers = new Set<(unanswered: number) => void>()
  const closed = new AbortController()
  let pending = 0
  let unanswered = 0
  const count = (change: number) => {
    pending += change
    listeners.forEach((listener) => listener(pending))
  }
  const track = (change: number) => {
    unanswered += change
    watchers.forEach((watcher) => watcher(unanswered))
  }

  function wait(milliseconds: number, signal: AbortSignal | null | undefined) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, milliseconds)
      wakers.add(done)
      signal?.addEventListener("abort", done, { once: true })
      closed.signal.addEventListener("abort", done, { once: true })
      function done() {
        clearTimeout(timer)
        wakers.delete(done)
        signal?.removeEventListener("abort", done)
        closed.signal.removeEventListener("abort", done)
        resolve()
      }
    })
  }

  async function send(fetch: typeof globalThis.fetch, input: string | URL, init: RequestInit): Promise<Response> {
    const path = new URL(input).pathname
    const deadline = Date.now() + (options.limit ?? limit)
    let counted = false
    track(1)
    try {
      while (true) {
        const attempt = await fetch(input, init).then<Attempt, Attempt>(
          async (response) => {
            if (response.status !== 503) return { response }
            const code = await response
              .clone()
              .json()
              .then((body: unknown) =>
                typeof body === "object" && body !== null && "code" in body ? body.code : undefined,
              )
              .catch(() => undefined)
            if (!switching(code)) return { response }
            await response.body?.cancel().catch(() => undefined)
            return { cause: new Error(`openforge answered ${String(code)}`), wait: retryAfter(response) }
          },
          (error: unknown) => {
            if (init.signal?.aborted || closed.signal.aborted) throw error
            if (refused(error) || repeats({ method: init.method ?? "GET", path, body: init.body }))
              return { cause: error, wait: 1_000 }
            throw error
          },
        )
        if ("response" in attempt) return attempt.response
        if (Date.now() >= deadline) throw new ResendTimeoutError({ cause: attempt.cause })
        if (!counted) count(1)
        counted = true
        await wait(Math.min(attempt.wait, deadline - Date.now()), init.signal)
        if (init.signal?.aborted) throw init.signal.reason
        if (closed.signal.aborted) throw new DOMException("The client closed before openforge took it", "AbortError")
      }
    } finally {
      if (counted) count(-1)
      track(-1)
    }
  }

  return {
    fetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
      const resending = (input: string | URL | Request, init?: RequestInit) => {
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
        // A request object or a streamed body cannot be sent twice; the generated clients send neither.
        if (READS.has(method) || input instanceof Request || init?.body instanceof ReadableStream)
          return fetch(input, init)
        // The switch's own pause and resume are never held back.
        if (new URL(input).pathname.includes(SERVICE_PATH)) return fetch(input, init)
        return send(fetch, input, init ?? {})
      }
      // Bun's fetch type carries preconnect; the clients never call it, and a browser's fetch has none.
      return Object.assign(resending, { preconnect: () => {} })
    },
    /** Another attempt is worthwhile now. */
    wake() {
      Array.from(wakers).forEach((wake) => wake())
    },
    pending: () => pending,
    subscribe(listener: (pending: number) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    unanswered: () => unanswered,
    /** Calls `watcher` with `unanswered()` whenever it changes. */
    watchUnanswered(watcher: (unanswered: number) => void) {
      watchers.add(watcher)
      return () => {
        watchers.delete(watcher)
      }
    },
    /** Gives up every write still waiting, as the client closes. */
    close() {
      closed.abort()
    },
  }
}

/** One send: the service's answer, or why it was not taken and how long to wait before the next. */
type Attempt = { readonly response: Response } | { readonly cause: unknown; readonly wait: number }

const READS = new Set(["GET", "HEAD", "OPTIONS"])
const SERVICE_PATH = "/api/experimental/service/"

function switching(code: unknown) {
  return code === "service_switching" || code === "service_starting" || code === "service_stopping"
}

function retryAfter(response: Response) {
  const seconds = Number(response.headers.get("retry-after"))
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 5) * 1_000 : 1_000
}

function carriesID(body: unknown) {
  if (typeof body !== "string") return false
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string"
  } catch {
    return false
  }
}

function causes(error: unknown) {
  const chain: unknown[] = []
  for (let current = error; current !== undefined && current !== null && chain.length < 8; ) {
    chain.push(current)
    current = current instanceof Error ? current.cause : undefined
  }
  return chain
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
