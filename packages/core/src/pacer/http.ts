export * as PacerHttp from "./http.js"

import { Clock, Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { PacerEndpoint } from "./endpoint.js"

/** No CPP is set up: no base URL or no key. */
export class NotSetUp extends Schema.TaggedError<NotSetUp>()("PacerHttp.NotSetUp", {}) {
  override get message() {
    return "CLIProxyPacer is not set up"
  }
}

/** CPP did not answer: the network failed, the call timed out, or it answered 5xx. */
export class Unreachable extends Schema.TaggedError<Unreachable>()("PacerHttp.Unreachable", {
  status: Schema.optional(Schema.Number),
  /** Milliseconds the answer's `Retry-After` asks to wait. */
  retryAfter: Schema.optional(Schema.Number),
  reason: Schema.String,
}) {
  override get message() {
    return `CLIProxyPacer is unreachable: ${this.reason}`
  }
}

/** CPP refused the key (401 or 403). */
export class Refused extends Schema.TaggedError<Refused>()("PacerHttp.Refused", {
  status: Schema.Number,
  reason: Schema.String,
}) {
  override get message() {
    return `CLIProxyPacer refused the key (${this.status}): ${this.reason}`
  }
}

/**
 * The proxy has no pacer: a 404 that is not CPP's own (a proxy without CPP's client API). Capabilities that say
 * `pacer: null` make the catalog's `pacer` null (`PacerModels`) rather than this error. CPP's 503 `unavailable` (its
 * pacer store not open yet) is {@link Unreachable}: it passes.
 */
export class NoPacer extends Schema.TaggedError<NoPacer>()("PacerHttp.NoPacer", {
  status: Schema.optional(Schema.Number),
  reason: Schema.String,
}) {
  override get message() {
    return `This proxy has no pacer: ${this.reason}`
  }
}

/** CPP's own 404 (`not_found`): the pacer runs, but holds nothing under that path, such as an unknown chat. */
export class NotFound extends Schema.TaggedError<NotFound>()("PacerHttp.NotFound", {
  reason: Schema.String,
}) {
  override get message() {
    return `CLIProxyPacer has no such item: ${this.reason}`
  }
}

/** Any other answer: a redirect (never followed), another 4xx, or a body that does not decode. */
export class Unexpected extends Schema.TaggedError<Unexpected>()("PacerHttp.Unexpected", {
  status: Schema.optional(Schema.Number),
  reason: Schema.String,
}) {
  override get message() {
    return `Unexpected answer from CLIProxyPacer: ${this.reason}`
  }
}

export type Error = NotSetUp | Unreachable | Refused | NoPacer | NotFound | Unexpected

/**
 * Bounds of the server's clock minus the local one, in milliseconds, from an answer's `Date` header: the server read
 * its clock as `Date` (whole seconds, so between `Date` and a second later) at a moment between the request's sending
 * and its answer's arrival, so the difference lies in [Date − arrival, Date + 1000 − sending].
 */
export interface Offset {
  readonly low: number
  readonly high: number
}

export interface Answer<A> {
  readonly body: A
  /** Undefined when the answer has no valid `Date`. */
  readonly offset: Offset | undefined
}

export interface StreamAnswer {
  readonly offset: Offset | undefined
  readonly headers: Readonly<Record<string, string>>
  /** The raw body. Ending or interrupting it closes the request. */
  readonly body: Stream.Stream<Uint8Array, Unreachable>
}

export interface Options {
  /** The endpoint to call; defaults to the current one. */
  readonly endpoint?: PacerEndpoint.Endpoint
  /** For a stream, until its headers arrive. Default 10 seconds. */
  readonly timeout?: Duration.Input
  readonly headers?: Readonly<Record<string, string>>
}

export interface Interface {
  readonly get: <A, I>(path: string, schema: Schema.Codec<A, I>, options?: Options) => Effect.Effect<Answer<A>, Error>
  readonly patch: <A, I>(
    path: string,
    body: unknown,
    schema: Schema.Codec<A, I>,
    options?: Options,
  ) => Effect.Effect<Answer<A>, Error>
  readonly post: <A, I>(
    path: string,
    body: unknown,
    schema: Schema.Codec<A, I>,
    options?: Options,
  ) => Effect.Effect<Answer<A>, Error>
  /** A GET whose body is read as it arrives, such as the change stream. */
  readonly stream: (path: string, options?: Options) => Effect.Effect<StreamAnswer, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerHttp") {}

const defaultTimeout = "10 seconds"

const ApiError = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      type: Schema.optional(Schema.String),
      code: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  }),
)
const decodeApiError = Schema.decodeUnknownOption(ApiError)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const endpoints = yield* PacerEndpoint.Service

    const send = Effect.fn("PacerHttp.send")(function* (
      request: (url: string) => HttpClientRequest.HttpClientRequest,
      path: string,
      options: Options | undefined,
      init: RequestInit,
    ) {
      const endpoint = options?.endpoint ?? (yield* endpoints.get())
      if (!endpoint) return yield* new NotSetUp()
      const url = target(endpoint, path)
      // A path that leaves the endpoint's origin would send the key elsewhere: a bug, not an answer.
      if (!url) return yield* Effect.die(new Error(`Not a path under CLIProxyPacer's root: ${path}`))
      const sent = yield* Clock.currentTimeMillis
      const response = yield* http
        .execute(
          request(url).pipe(
            HttpClientRequest.setHeaders(options?.headers ?? {}),
            HttpClientRequest.bearerToken(endpoint.key),
          ),
        )
        .pipe(
          // Never follow a redirect: the key would go with it to wherever it points.
          Effect.provideService(FetchHttpClient.RequestInit, init),
          Effect.mapError(unreachable),
        )
      return { response, offset: offset(response.headers.date, sent, yield* Clock.currentTimeMillis) }
    })

    const json = <A, I>(
      request: (url: string) => HttpClientRequest.HttpClientRequest,
      path: string,
      schema: Schema.Codec<A, I>,
      options: Options | undefined,
    ) =>
      Effect.gen(function* () {
        const sent = yield* send(request, path, options, { redirect: "manual" })
        const text = yield* sent.response.text.pipe(Effect.mapError(unreachable))
        const refused = refusal(sent.response, text)
        if (refused) return yield* refused
        const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
          Effect.mapError(
            (error) =>
              new Unexpected({ status: sent.response.status, reason: `the answer does not decode: ${error.message}` }),
          ),
        )
        return { body, offset: sent.offset } satisfies Answer<A>
      }).pipe(timeout(options))

    return Service.of({
      get: (path, schema, options) =>
        json((url) => HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson), path, schema, options),
      patch: (path, body, schema, options) =>
        json(
          (url) =>
            HttpClientRequest.patch(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bodyJsonUnsafe(body)),
          path,
          schema,
          options,
        ),
      post: (path, body, schema, options) =>
        json(
          (url) =>
            HttpClientRequest.post(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bodyJsonUnsafe(body)),
          path,
          schema,
          options,
        ),
      stream: (path, options) =>
        Effect.gen(function* () {
          // Bun's fetch would end a quiet stream after five minutes; the caller watches the heartbeat instead.
          const sent = yield* send(HttpClientRequest.get, path, options, {
            redirect: "manual",
            timeout: false,
          } as BunFetchRequestInit)
          if (sent.response.status < 200 || sent.response.status >= 300) {
            const refused = refusal(sent.response, yield* sent.response.text.pipe(Effect.mapError(unreachable)))
            if (refused) return yield* refused
          }
          return {
            offset: sent.offset,
            headers: sent.response.headers,
            body: sent.response.stream.pipe(Stream.mapError(unreachable)),
          } satisfies StreamAnswer
        }).pipe(timeout(options)),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [PacerEndpoint.node, httpClient] })

/** The request URL for a path under the endpoint's root, when it stays on the endpoint's origin. */
function target(endpoint: PacerEndpoint.Endpoint, path: string) {
  const url = path.startsWith("/") && URL.canParse(endpoint.root + path) ? new URL(endpoint.root + path) : undefined
  return url?.origin === endpoint.origin ? url.href : undefined
}

/** The error class of an answer that is not a 2xx; undefined for a 2xx. */
function refusal(response: HttpClientResponse.HttpClientResponse, text: string) {
  const status = response.status
  if (status >= 200 && status < 300) return undefined
  const error = Option.getOrUndefined(decodeApiError(text))?.error
  const reason = error?.message ?? error?.type ?? `HTTP ${status}`
  if (status >= 300 && status < 400) return new Unexpected({ status, reason: `redirect (${status}) refused` })
  if (status === 401 || status === 403) return new Refused({ status, reason })
  if (status === 404 && error?.type === "not_found") return new NotFound({ reason })
  if (status === 404) return new NoPacer({ status, reason })
  if (status >= 500) return new Unreachable({ status, retryAfter: retryAfter(response.headers["retry-after"]), reason })
  return new Unexpected({ status, reason })
}

function timeout(options: Options | undefined) {
  const duration = options?.timeout ?? defaultTimeout
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () =>
          Effect.fail(
            new Unreachable({ reason: `no answer within ${Duration.format(Duration.fromInputUnsafe(duration))}` }),
          ),
      }),
    )
}

function unreachable(error: HttpClientError.HttpClientError) {
  const cause = error.reason._tag === "TransportError" ? error.reason.cause : undefined
  return new Unreachable({
    reason: cause instanceof Error && cause.message ? `${error.message}: ${cause.message}` : error.message,
  })
}

function offset(date: string | undefined, sent: number, arrived: number): Offset | undefined {
  const server = date === undefined ? Number.NaN : Date.parse(date)
  return Number.isFinite(server) ? { low: server - arrived, high: server + 1000 - sent } : undefined
}

function retryAfter(value: string | undefined) {
  const seconds = value === undefined || value.trim() === "" ? Number.NaN : Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}
