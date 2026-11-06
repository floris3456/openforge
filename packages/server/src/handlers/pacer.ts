import { PacerConnection } from "@opencode/core/pacer/connection"
import type { Session } from "@opencode/core/session"
import { ServiceUnavailableError } from "@opencode/protocol/errors"
import type { RequestsQuery } from "@opencode/protocol/groups/pacer"
import type { Pacer } from "@opencode/schema/pacer"
import { Effect } from "effect"

const unavailable = (error: PacerConnection.Unavailable) =>
  new ServiceUnavailableError({ message: error.message, service: "cliproxypacer" })

/** `pacer.*` in the `server.experimental` group: the service's connection to CLIProxyPacer. */
export const makePacer = Effect.gen(function* () {
  const pacer = yield* PacerConnection.Service

  return {
    status: Effect.map(pacer.status(), (data) => ({ data })),
    accounts: Effect.map(pacer.accounts(), (data) => ({ data: data ?? null })),
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
    prompt: (requestID: string) =>
      pacer.prompt(requestID).pipe(
        Effect.map((data) => ({ data: data ?? null })),
        Effect.mapError(unavailable),
      ),
  }
})
