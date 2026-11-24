import { PacerConnection } from "@opencode/core/pacer/connection"
import { PacerInspect } from "@opencode/core/pacer/inspect"
import { PacerModels } from "@opencode/core/pacer/models"
import type { Session } from "@opencode/core/session"
import { ServiceUnavailableError } from "@opencode/protocol/errors"
import type { RequestsQuery } from "@opencode/protocol/groups/pacer"
import type { Pacer } from "@opencode/schema/pacer"
import { Effect, FiberHandle } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiSchema } from "effect/http-api"

const unavailable = (error: PacerConnection.Unavailable) =>
  new ServiceUnavailableError({ message: error.message, service: "cliproxypacer" })

/** `pacer.*` in the `server.experimental` group: the service's connection to CLIProxyPacer. */
export const makePacer = Effect.gen(function* () {
  const pacer = yield* PacerConnection.Service
  const models = yield* PacerModels.Service
  const inspect = yield* PacerInspect.Service
  // The model picker's read of CPP's models outlives its request. While one runs, another call starts none: the read
  // under way already brings what a second would.
  const reading = yield* FiberHandle.make<void, never>()

  return {
    status: Effect.map(pacer.status(), (data) => ({ data })),
    accounts: Effect.map(pacer.accounts(), (data) => ({ data: data ?? null })),
    models: Effect.map(pacer.models(), (data) => ({ data: data ?? null })),
    chat: (sessionID: Session.ID) => Effect.map(pacer.chat(sessionID), (data) => ({ data: data ?? null })),
    update: (sessionID: Session.ID, input: Pacer.ChatUpdate) =>
      pacer.update(sessionID, input).pipe(
        Effect.map((data) => ({ data })),
        Effect.mapError(unavailable),
      ),
    requests: (sessionID: Session.ID, query: typeof RequestsQuery.Type) =>
      pacer.requests(sessionID, { filter: query.filter ?? "all", cursor: query.cursor, limit: query.limit }).pipe(
        Effect.map((data) => ({ data })),
        Effect.mapError(unavailable),
      ),
    refresh: FiberHandle.run(reading, models.refresh(), { onlyIfMissing: true }).pipe(
      Effect.as(HttpApiSchema.NoContent.make()),
    ),
    prompt: (requestID: string) =>
      pacer.prompt(requestID).pipe(
        Effect.map((data) => ({ data: data ?? null })),
        Effect.mapError(unavailable),
      ),
    settings: () =>
      pacer.settings().pipe(
        Effect.map((data) => ({ data })),
        Effect.mapError(unavailable),
      ),
    updateSettings: (input: Pacer.SettingsUpdate) =>
      pacer.updateSettings(input).pipe(
        Effect.map((data) => ({ data })),
        Effect.mapError(unavailable),
      ),
    /**
     * `pacer.inspect.*`: CPP's `/pacer/v1/inspect/<path>` with the route's own fields, its answer as it came. Only the
     * fields the route declares go on, so the key reaches these reads and no other.
     */
    inspect: (path: string, query: Readonly<Record<string, string | undefined>>) =>
      Effect.gen(function* () {
        const fields = new URLSearchParams(
          Object.entries(query).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
        ).toString()
        const answer = yield* inspect.relay(fields ? `${path}?${fields}` : path)
        return HttpServerResponse.text(answer.body, {
          status: answer.status,
          contentType: answer.contentType,
          headers: { "cache-control": "no-store", ...(answer.next ? { "x-pacer-next": answer.next } : {}) },
        })
      }),
  }
})
