import { Agent } from "@opencode/core/agent"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { PacerConnection } from "@opencode/core/pacer/connection"
import { PacerIdentity } from "@opencode/core/pacer/identity"
import { PacerInspect } from "@opencode/core/pacer/inspect"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerProject } from "@opencode/core/pacer/project"
import { Session } from "@opencode/core/session"
import { InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import type { RequestsQuery } from "@opencode/protocol/groups/pacer"
import type { Pacer } from "@opencode/schema/pacer"
import { Effect, FiberHandle } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiSchema } from "effect/http-api"
import { locationErrors } from "../location"
import { missingSession } from "./session-error"

const unavailable = (error: PacerConnection.Unavailable) =>
  new ServiceUnavailableError({ message: error.message, service: "cliproxypacer" })

/** `/identity`'s refusals in words for the person, CPP's that can't be asked as unavailable. */
const identityError = (error: PacerIdentity.Error) =>
  error._tag === "PacerIdentity.Refused"
    ? new InvalidRequestError({ message: error.message, kind: "identity" })
    : new ServiceUnavailableError({ message: error.message, service: "cliproxypacer" })

/** `pacer.*` in the `server.experimental` group: the service's connection to CLIProxyPacer. */
export const makePacer = Effect.gen(function* () {
  const pacer = yield* PacerConnection.Service
  const models = yield* PacerModels.Service
  const inspect = yield* PacerInspect.Service
  const identity = yield* PacerIdentity.Service
  const sessions = yield* Session.Service
  const locations = yield* LocationServiceMap.Service

  /**
   * The chat as `/identity` names it to CPP: its project (a helper's own, else its lead's) and agent, in its own
   * location; refused outside a project.
   */
  const identityChat = Effect.fn("pacer.identityChat")(function* (sessionID: Session.ID) {
    const session = yield* sessions.get(sessionID).pipe(Effect.mapError(missingSession))
    const found = yield* Effect.gen(function* () {
      const projects = yield* PacerProject.Service
      const agents = yield* Agent.Service
      return { chat: yield* projects.session(session), agent: String((yield* agents.select(session.agent)).id) }
    }).pipe(Effect.provide(locations.get(session.location)), locationErrors)
    if (found.chat.project === undefined)
      return yield* new InvalidRequestError({ message: found.chat.why, kind: "identity" })
    return {
      sessionID,
      ...(session.parentID ? { parentID: session.parentID } : {}),
      agent: found.agent,
      project: found.chat.project,
      headers: found.chat.headers,
    } satisfies PacerIdentity.Chat
  })
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
    features: Effect.map(identity.features(), (data) => ({ data })),
    identities: (sessionID: Session.ID) =>
      identityChat(sessionID).pipe(
        Effect.flatMap((chat) => identity.list(chat).pipe(Effect.mapError(identityError))),
        Effect.map((data) => ({ data })),
      ),
    link: (sessionID: Session.ID, to: Pacer.IdentityLink) =>
      identityChat(sessionID).pipe(
        Effect.flatMap((chat) => identity.link(chat, to).pipe(Effect.mapError(identityError))),
        Effect.map((data) => ({ data })),
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
