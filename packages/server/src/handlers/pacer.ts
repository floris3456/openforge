import { PacerConnection } from "@opencode/core/pacer/connection"
import type { Session } from "@opencode/core/session"
import { ServiceUnavailableError } from "@opencode/protocol/errors"
import type { RequestsQuery } from "@opencode/protocol/groups/pacer"
import type { Pacer } from "@opencode/schema/pacer"
import { Clock, Effect, Option } from "effect"

const unavailable = (error: PacerConnection.Unavailable) =>
  new ServiceUnavailableError({ message: error.message, service: "cliproxypacer" })

/** `pacer.*` in the `server.experimental` group: the service's connection to CLIProxyPacer. */
export const makePacer = Effect.gen(function* () {
  // The connection's node is registered once part 1's PacerModels.node is in; until then this server has no
  // connection to CPP and answers as one where CPP is not set up. Require the service once the node is registered.
  const started = yield* Clock.currentTimeMillis
  const pacer = Option.getOrElse(yield* Effect.serviceOption(PacerConnection.Service), () => none(started))

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

/** A server without the connection: CPP is not set up, so there is nothing to read. */
function none(since: number): PacerConnection.Interface {
  const refuse = Effect.fail(new PacerConnection.Unavailable({ state: "unset", reason: "it is not set up" }))
  return {
    status: () => Effect.succeed({ state: "unset", since, refused: false }),
    accounts: () => Effect.succeed(undefined),
    chat: () => Effect.succeed(undefined),
    update: () => refuse,
    requests: () => refuse,
    prompt: () => refuse,
  }
}
