export * as Follow from "./follow"

import { mkdirSync, watch } from "node:fs"
import path from "node:path"
import { ClientError, OpenCode } from "@opencode/client"
import { Service, type Endpoint } from "@opencode/client/effect/service"
import { Attention } from "@opencode/schema/attention"
import { Product } from "@opencode/schema/product"
import { Option, Schema } from "effect"
import { errorMessage } from "../util/error"
import { Relay } from "./relay"

// How `openforge notify` stays with one service: the one on this machine, followed over its attention stream, or one
// on another machine through the relay there. Nothing here polls: a missing service is waited for through its
// registration file, a connection that stays quiet too long is dropped and made again. Only a service that registered
// and answers that it is still starting is asked again on a timer, since it becomes ready without writing its file.

/** The service sends a heartbeat every 15 s, the relay says it is alive as often: this long without either is dead. */
export const IDLE_MS = 45_000
/** A lost connection is made again after 1 s, then after twice as long each time it fails, up to 30 s. */
export const RECONNECT_FIRST_MS = 1_000
export const RECONNECT_MAX_MS = 30_000
/** A connection that stayed up this long starts the waits over. */
export const STABLE_MS = 60_000
/** A service that is still starting is asked again after this long, then twice as long each time, up to 30 s. */
const STARTING_FIRST_MS = 250

const decodeEvent = Schema.decodeUnknownOption(Attention.FollowEvent)

export interface Events {
  /** For the person at the player. */
  readonly say: (line: string) => void
  /** Only with --verbose. */
  readonly debug: (line: string) => void
  readonly following: (url: string, version: string) => void
  readonly occurrence: (occurrence: Attention.Occurrence, test: boolean) => void
  /** How long a connection may stay quiet before it counts as dead; IDLE_MS unless a test shortens it. */
  readonly idleMs?: number
}

/** Reconnect wait after `failures` failed connections in a row (the first is 1). */
export function reconnectDelay(failures: number) {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_FIRST_MS * 2 ** Math.max(0, failures - 1))
}

/**
 * Follows the service on this machine until `signal` aborts, never starting one: while none runs it says so once and
 * waits for one to register; when the service goes away it waits for the next. With `test`, asks the first service it
 * follows for a test occurrence.
 */
export async function local(
  input: Events & {
    readonly desktop: boolean
    readonly test?: Attention.TestKind
    /**
     * The service its registration file names and how it answers, never started: none for no file, a stale one or a
     * service that does not answer as one.
     */
    readonly discover: () => Promise<{ readonly endpoint: Endpoint; readonly state: Found } | undefined>
    readonly registration: string
  },
  signal: AbortSignal,
) {
  const state = { tested: input.test === undefined, waiting: false, failed: "", retry: STARTING_FIRST_MS }
  while (!signal.aborted) {
    // Watch before looking, so a service that registers in between is not missed.
    const registered = watchRegistration(input.registration)
    const found = await input.discover().catch((error: unknown) => {
      input.debug(`Looking for the service failed: ${errorMessage(error)}`)
      return undefined
    })
    if (found?.state !== "ready") {
      if (!state.waiting) input.say(`No ${Product.name} service runs here; waiting for one to start.`)
      state.waiting = true
      if (found?.state === "failed" && state.failed !== found.endpoint.url)
        input.say(`The service at ${found.endpoint.url} failed to start; waiting for one to start.`)
      state.failed = found?.state === "failed" ? found.endpoint.url : ""
      // It becomes ready without writing its file again, so only it is asked again on a timer.
      const starting = found?.state === "waiting"
      if (starting) input.debug(`The service at ${found.endpoint.url} is starting; looking again in ${state.retry} ms.`)
      const changed = await registered.next(signal, starting ? state.retry : undefined)
      registered.close()
      state.retry = starting && !changed ? Math.min(RECONNECT_MAX_MS, state.retry * 2) : STARTING_FIRST_MS
      continue
    }
    registered.close()
    state.waiting = false
    const end = await follow(found.endpoint, input, state, signal)
    if (signal.aborted) return
    if (end.following) {
      input.say(`The service at ${found.endpoint.url} stopped: ${end.reason}.`)
      continue
    }
    // A service that refused the stream stays as it is until another one registers.
    input.say(`Could not follow the service at ${found.endpoint.url}: ${end.reason}.`)
    state.waiting = true
    const next = watchRegistration(input.registration)
    input.say(`Waiting for another ${Product.name} service to start.`)
    await next.next(signal)
    next.close()
  }
}

/** How a registered service answers: ready, still starting (503), or failed to start (500). */
export type Found = "ready" | "waiting" | "failed"

async function follow(
  endpoint: Endpoint,
  input: Parameters<typeof local>[0],
  state: { tested: boolean },
  outer: AbortSignal,
) {
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const idleMs = input.idleMs ?? IDLE_MS
  const quiet = new AbortController()
  const signal = AbortSignal.any([outer, quiet.signal])
  const idle = { timer: setTimeout(() => quiet.abort(), idleMs) }
  const active = () => {
    clearTimeout(idle.timer)
    idle.timer = setTimeout(() => quiet.abort(), idleMs)
  }
  const result = { following: false }
  const reason = await (async () => {
    for await (const event of client.experimental.attention.follow(
      { desktop: input.desktop },
      { signal, onActivity: active },
    )) {
      const decoded = Option.getOrUndefined(decodeEvent(event))
      if (decoded === undefined) {
        input.debug(`Ignored an event this version cannot read: ${JSON.stringify(event)}`)
        continue
      }
      if (decoded.type === "occurrence") {
        input.occurrence(decoded.occurrence, decoded.test === true)
        continue
      }
      result.following = true
      input.following(endpoint.url, decoded.version)
      if (state.tested || input.test === undefined) continue
      state.tested = true
      const kind = input.test
      void client.experimental.attention.test({ kind }, { signal }).then(
        () => input.debug(`Asked the service for a test ${kind}.`),
        (error: unknown) => input.say(`The test failed: ${errorMessage(error)}.`),
      )
    }
    return "it closed the stream"
  })().catch((error: unknown) => {
    if (quiet.signal.aborted) return `no data from it for ${idleMs / 1_000} s`
    if (error instanceof ClientError && error.reason === "UnexpectedStatus" && statusOf(error) === 404)
      return "it has no notification stream (an older release)"
    if (error instanceof ClientError && error.reason === "Transport") return "the connection broke"
    return errorMessage(error)
  })
  clearTimeout(idle.timer)
  return { reason, following: result.following }
}

function statusOf(error: ClientError) {
  const cause: unknown = error.cause
  if (typeof cause === "object" && cause !== null && "status" in cause) return cause.status
}

/** Resolves when the registration file is written or removed; `next` answers whether it changed or the wait ended. */
function watchRegistration(file: string) {
  const directory = path.dirname(file)
  // The service makes this folder when it registers; making it first lets the folder be watched.
  mkdirSync(directory, { recursive: true })
  const changed = Promise.withResolvers<boolean>()
  const watcher = watch(directory, (_event, name) => {
    if (name === null || name === path.basename(file)) changed.resolve(true)
  })
  watcher.on("error", () => changed.resolve(true))
  return {
    next(signal: AbortSignal, ms?: number) {
      if (signal.aborted) return Promise.resolve(false)
      const timer = ms === undefined ? undefined : setTimeout(() => changed.resolve(false), ms)
      const abort = () => changed.resolve(false)
      signal.addEventListener("abort", abort, { once: true })
      return changed.promise.finally(() => {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
      })
    },
    close: () => watcher.close(),
  }
}

/**
 * The service on another machine, through the relay there (`ssh -T <target>` or `--via <command>`), until `signal`
 * aborts. When the connection ends it is made again after 1 s, then twice as long each time, up to 30 s, saying so
 * each time.
 */
export async function remote(
  input: Events & {
    readonly route: Relay.Route
    readonly label: string
    readonly desktop: boolean
    readonly verbose: boolean
    readonly test?: Attention.TestKind
    /** A custom sound file the relay sent along. */
    readonly soundFile: (file: string, data: Uint8Array | Error) => void
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  },
  signal: AbortSignal,
) {
  const sleep = input.sleep ?? wait
  const state = { failures: 0, tested: input.test === undefined }
  while (!signal.aborted) {
    // The test is asked for by the first relay that follows its service, not again after a reconnect.
    const flags = Relay.flags({
      desktop: input.desktop,
      verbose: input.verbose,
      test: state.tested ? undefined : input.test,
    })
    const end = await connect(input, flags, signal)
    state.tested ||= end.following
    if (signal.aborted) return
    state.failures = end.upMs >= STABLE_MS ? 1 : state.failures + 1
    const delay = reconnectDelay(state.failures)
    input.say(
      end.hello
        ? `Lost the connection to ${input.label}: ${end.reason}. Reconnecting in ${delay / 1_000} s.`
        : `Could not reach ${Product.name} on ${input.label}: ${end.reason}. Trying again in ${delay / 1_000} s.`,
    )
    await sleep(delay, signal)
  }
}

async function connect(input: Parameters<typeof remote>[0], flags: readonly string[], signal: AbortSignal) {
  const argv = Relay.command(input.route, flags)
  input.debug(
    `Starting the relay: ${argv.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word}'`)).join(" ")}`,
  )
  // Its stdin stays open: the relay there stops when it closes. ssh asks for passwords on the terminal itself.
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const stop = () => child.kill()
  signal.addEventListener("abort", stop, { once: true })
  const state = { hello: false, following: false, at: 0, last: "", quiet: false, mismatch: "" }
  const idleMs = input.idleMs ?? IDLE_MS
  const idle = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const active = () => {
    clearTimeout(idle.timer)
    idle.timer = setTimeout(() => {
      state.quiet = true
      child.kill()
    }, idleMs)
  }
  const stderr = (async () => {
    for await (const line of lines(child.stderr)) {
      state.last = line
      input.debug(`${input.label}: ${line}`)
    }
  })()
  for await (const text of lines(child.stdout)) {
    const line = Relay.decode(text)
    if (line === undefined) {
      input.debug(`${input.label} printed: ${text}`)
      continue
    }
    if (state.hello) active()
    if (line.type === "hello") {
      state.hello = true
      state.at = Date.now()
      active()
      if (line.version === Relay.VERSION) continue
      state.mismatch = `${Product.name} there writes relay lines of version ${line.version}, this one reads ${Relay.VERSION}; update both`
      child.kill()
      break
    }
    if (line.type === "status") input.say(`${input.label}: ${line.text}`)
    if (line.type === "debug") input.debug(`${input.label}: ${line.text}`)
    if (line.type === "following") {
      state.following = true
      input.following(line.url, line.version)
    }
    if (line.type !== "occurrence") continue
    if (line.sound !== undefined)
      input.soundFile(
        line.sound.file,
        "data" in line.sound ? Buffer.from(line.sound.data, "base64") : new Error(line.sound.error),
      )
    input.occurrence(line.occurrence, line.test === true)
  }
  const code = await child.exited
  await stderr
  clearTimeout(idle.timer)
  signal.removeEventListener("abort", stop)
  const reason =
    state.mismatch ||
    (state.quiet ? `no word from the relay for ${idleMs / 1_000} s` : "") ||
    Relay.ended(input.label, "target" in input.route, code, state.last)
  return { hello: state.hello, following: state.following, upMs: state.hello ? Date.now() - state.at : 0, reason }
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const state = { rest: "" }
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const split = (state.rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/)
    state.rest = split.pop() ?? ""
    yield* split.filter((line) => line.trim() !== "")
  }
  if (state.rest.trim() !== "") yield state.rest
}

function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}
