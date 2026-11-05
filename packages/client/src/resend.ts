// Writes that a release switch must not lose. While the service switches it cannot be reached for a moment, and
// the new release refuses writes with 503 until it is resumed (`ServiceSwitch.refused`), so that a rollback cannot
// lose one. Neither kind of failure reached the service, so any write is sent again until the service takes it, up
// to the resender's limit. A connection that drops after the request went out is different: the old service may have
// taken it just before it stopped. Only a write the service may get twice and end up the same is resent then: one
// that sets something, settles a request by its id, or carries an id the service ignores when it sees it again.
import { ServiceSwitch } from "@opencode/protocol/service-switch"
import { Product } from "@opencode/schema/product"
import { spokenDuration } from "./continuity.js"

/** How long a write is resent before it is reported. */
const defaultLimit = 120_000

/** Reported when the service did not take a write within the resend limit. */
export class ResendTimeoutError extends Error {
  override readonly name = "ResendTimeoutError"
  constructor(limit: number, options?: ErrorOptions) {
    super(
      `${Product.name} did not take it within ${spokenDuration(limit)}; it was switching releases or could not be reached`,
      options,
    )
  }
}

/** The write given up after the resend limit, also when another error wraps it as its `cause`. */
export function findResendTimeout(error: unknown): ResendTimeoutError | undefined {
  if (error instanceof ResendTimeoutError) return error
  if (error instanceof Error) return findResendTimeout(error.cause)
}

export type Resender = ReturnType<typeof createResender>

/**
 * Resends every write sent through the `fetch` it wraps, as described above. A write that waits tries again when the
 * client hears, through `observe`, that the event stream reached a service again (`server.connected`: it was down,
 * starting or stopping) or that the new release resumed (`service.resumed`: it was paused). Those two events end every
 * wait a switch causes, so there is no timer but the limit: a client that never observes its event stream only sees a
 * waiting write fail at its limit. `pending` counts the writes waiting to be resent; `unanswered` counts every write
 * the service has not answered yet, from its first attempt on, so a client that is about to go away (a TUI restarting
 * on a new release) can wait for a write that is still on its way.
 */
export function createResender(options: { readonly limit?: number } = {}) {
  const limit = options.limit ?? defaultLimit
  const wakers = new Set<() => void>()
  const listeners = new Set<(pending: number) => void>()
  const watchers = new Set<(unanswered: number) => void>()
  const closed = new AbortController()
  let pending = 0
  let unanswered = 0
  // Counts wakes, so a write whose attempt failed while one arrived tries again at once instead of waiting for the next.
  let wakes = 0
  const count = (change: number) => {
    pending += change
    listeners.forEach((listener) => listener(pending))
  }
  const track = (change: number) => {
    unanswered += change
    watchers.forEach((watcher) => watcher(unanswered))
  }
  const wake = () => {
    wakes++
    Array.from(wakers).forEach((waker) => waker())
  }

  // Until a wake, the deadline, or an abort of the write or the client.
  function wait(deadline: number, signal: AbortSignal | null | undefined) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, deadline - Date.now())
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
    const deadline = Date.now() + limit
    let counted = false
    track(1)
    try {
      while (true) {
        const woken = wakes
        const attempt = await fetch(input, init).then<Attempt, Attempt>(
          async (response) => {
            if (response.status !== 503) return { response }
            const code = await response
              .clone()
              .json()
              .then((body: unknown) =>
                typeof body === "object" && body !== null && "code" in body ? body.code : undefined,
              )
              // A 503 without a JSON body is not the service's own refusal.
              .catch(() => undefined)
            if (!switching(code)) return { response }
            await response.body?.cancel()
            return { cause: new Error(`${Product.name} answered ${String(code)}`) }
          },
          (error: unknown) => {
            if (init.signal?.aborted || closed.signal.aborted) throw error
            if (refused(error) || repeats({ method: init.method ?? "GET", path, body: init.body }))
              return { cause: error }
            throw error
          },
        )
        if ("response" in attempt) return attempt.response
        if (Date.now() >= deadline) throw new ResendTimeoutError(limit, { cause: attempt.cause })
        if (!counted) count(1)
        counted = true
        if (woken === wakes) await wait(deadline, init.signal)
        if (init.signal?.aborted) throw init.signal.reason
        if (closed.signal.aborted)
          throw new DOMException(`The client closed before ${Product.name} took it`, "AbortError")
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
        if (ServiceSwitch.reads.has(method) || input instanceof Request || init?.body instanceof ReadableStream)
          return fetch(input, init)
        // The switch's own pause and resume are never held back.
        if (new URL(input).pathname.includes(ServiceSwitch.path)) return fetch(input, init)
        return send(fetch, input, init ?? {})
      }
      // Bun's fetch type carries preconnect; the clients never call it, and a browser's fetch has none.
      return Object.assign(resending, { preconnect: () => {} })
    },
    /** Hears an event from the service's stream; the ones that end a switch's wait make waiting writes try again. */
    observe(event: { readonly type: string }) {
      if (event.type === "server.connected" || event.type === "service.resumed") wake()
    },
    pending: () => pending,
    /** Calls `listener` with `pending()` whenever it changes. */
    watchPending(listener: (pending: number) => void) {
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

/** One send: the service's answer, or why it was not taken. */
type Attempt = { readonly response: Response } | { readonly cause: unknown }

// The service's 503 while it is paused, starting or stopping: the write never reached it.
function switching(code: unknown) {
  return code === ServiceSwitch.refused.code || code === ServiceSwitch.starting || code === ServiceSwitch.stopping
}

// The connection was refused, so the request never reached a service.
function refused(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && (error.code === "ECONNREFUSED" || error.code === "ConnectionRefused")) return true
  if (error instanceof Error && /\bECONNREFUSED\b/.test(error.message)) return true
  return "cause" in error && refused(error.cause)
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

// Whether a write may be resent after a connection that dropped once the request went out.
function repeats(request: { readonly method: string; readonly path: string; readonly body?: unknown }) {
  const method = request.method.toUpperCase()
  if (method === "PUT" || method === "PATCH" || method === "DELETE") return true
  if (method !== "POST") return false
  return repeatable.some((rule) => rule.path.test(request.path) && (!rule.id || carriesID(request.body)))
}

// The promise client runs without Effect, so this reads the body without its schemas.
function carriesID(body: unknown) {
  if (typeof body !== "string") return false
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string"
  } catch {
    return false
  }
}
