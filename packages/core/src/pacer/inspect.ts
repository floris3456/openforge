export * as PacerInspect from "./inspect.js"

import { randomBytes, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { PacerEndpoint } from "./endpoint.js"
import { PacerHttp } from "./http.js"
import { PacerModels } from "./models.js"

/**
 * Reading other projects on CPP from an agent's shell (workspace spec `docs/specs/cpp-inspect-cli.md`): `openforge
 * cpp` asks the service, which asks CPP with the install's client key, so the key never enters the shell. A chat's
 * command gets the service's address and a token made at each start of the service and held only in its memory; the
 * token opens the inspection routes alone.
 */

/** The service's inspection routes: the token opens these and no other. */
export const PREFIX = "/api/experimental/pacer/inspect/"

/** The variables the shell tool gives every command. */
export const URL_VARIABLE = "OPENFORGE_CPP_URL"
export const TOKEN_VARIABLE = "OPENFORGE_CPP_TOKEN"

/** CPP's answer to pass on, or the service's own refusal in CPP's shape (`{error: {type, message}}`). */
export interface Answer {
  readonly status: number
  readonly contentType: string
  /** The next page's cursor of a text answer (`X-Pacer-Next`). */
  readonly next?: string
  readonly body: string
}

export interface Interface {
  /** {@link URL_VARIABLE} and {@link TOKEN_VARIABLE}; none when the service has no address of its own. */
  readonly env: () => Readonly<Record<string, string>>
  /** Whether `token` is this start's. */
  readonly accepts: (token: string) => boolean
  /** One read under CPP's `/pacer/v1/inspect/` (`path` with its query), with the key; CPP's answer unchanged. */
  readonly relay: (path: string) => Effect.Effect<Answer>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerInspect") {}

export interface Options {
  /** The service's own address, once it listens. */
  readonly url?: () => string | undefined
}

export const NO_CPP = "openforge has no CLIProxyPacer set up: openforge auth login cliproxypacer."
export const NO_INSPECTION = "This CLIProxyPacer has no inspection yet."

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const http = yield* PacerHttp.Service
      const endpoints = yield* PacerEndpoint.Service
      const models = yield* PacerModels.Service
      const token = randomBytes(32)
      const said = token.toString("base64url")

      const relay = Effect.fn("PacerInspect.relay")(function* (path: string) {
        const catalog = yield* models.get()
        // A CPP whose capabilities say memory and not inspection is one from before it; unknown capabilities, or none
        // of memory (CPP's memory off: CPP says so itself), go on to CPP.
        if (catalog?.pacer === null || (catalog?.pacer?.memory && !catalog.pacer.memory.inspect))
          return refused(404, "no_inspection", NO_INSPECTION)
        return yield* http.relay(`/pacer/v1/inspect/${path}`, { failover: true, timeout: "30 seconds" }).pipe(
          Effect.map(
            (answer): Answer => ({
              status: answer.status,
              contentType: answer.headers["content-type"] ?? "application/json",
              ...(answer.headers["x-pacer-next"] ? { next: answer.headers["x-pacer-next"] } : {}),
              body: answer.body,
            }),
          ),
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (error._tag === "PacerHttp.NotSetUp") return refused(503, "not_set_up", NO_CPP)
              const at = yield* endpoints.get()
              return refused(
                502,
                "unreachable",
                `CLIProxyPacer can't be reached at ${at?.origin ?? "its address"} now: ${reasonOf(error)}.`,
              )
            }),
          ),
        )
      })

      return Service.of({
        env: (): Readonly<Record<string, string>> => {
          const url = options.url?.()
          return url ? { [URL_VARIABLE]: url, [TOKEN_VARIABLE]: said } : {}
        },
        accepts: (given) => {
          const bytes = Buffer.from(given, "base64url")
          return given === bytes.toString("base64url") && bytes.length === token.length && timingSafeEqual(bytes, token)
        },
        relay,
      })
    }),
  )

export function configured(options: Options = {}) {
  return makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [PacerHttp.node, PacerEndpoint.node, PacerModels.node],
  })
}

export const node = configured()

function refused(status: number, type: string, message: string): Answer {
  return { status, contentType: "application/json", body: JSON.stringify({ error: { type, message } }) }
}

function reasonOf(error: PacerHttp.Error) {
  const reason = "reason" in error ? error.reason : error.message
  return reason.replace(/\.$/, "")
}
