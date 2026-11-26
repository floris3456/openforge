export * as PacerIdentity from "./identity.js"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { Pacer } from "@opencode/schema/pacer"
import type { SessionID } from "@opencode/schema/session-id"
import { PacerBadges } from "./badges.js"
import { PacerHeaders } from "./headers.js"
import { PacerHttp } from "./http.js"
import { PacerModels } from "./models.js"
import { PacerSessionID } from "./session-id.js"

/**
 * The owner's `/identity` (the workspace's spec `docs/specs/agent-badges.md`, section 1, item 6; reference
 * `docs/reference/agent-identity-api.md`): CPP keeps an identity per agent and project, and the TUI's command links a
 * chat to an earlier one through an `identity` event on the chat's events. Offered only while CPP's capabilities say
 * `identities`; no agent tool reaches it.
 */

/** A chat as `/identity` names it to CPP: itself, its parent, the agent it runs as, and its project. */
export interface Chat {
  readonly sessionID: SessionID
  readonly parentID?: SessionID
  /** The agent the chat runs as: an identity `/identity new` makes takes it as its role. */
  readonly agent: string
  /** The chat's memory project (`PacerProject.chat`). */
  readonly project: string
  /** The headers that name it. */
  readonly headers: Readonly<Record<string, string>>
}

/** CPP said why not, or this one cannot ask: in words for the person. */
export class Refused extends Schema.TaggedError<Refused>()("PacerIdentity.Refused", { reason: Schema.String }) {
  override get message() {
    return this.reason
  }
}

/** CPP cannot be asked now: not set up, unreachable, or it refused the key. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("PacerIdentity.Unavailable", {
  reason: Schema.String,
}) {
  override get message() {
    return `CLIProxyPacer can't be asked now: ${this.reason}`
  }
}

export type Error = Refused | Unavailable

export interface Interface {
  /** What the connected CPP offers, from its capabilities as last read; nothing offered before they are. */
  readonly features: () => Effect.Effect<Pacer.Features>
  /** The identities of the chat's project, the most recently active first, and the one the chat is now. */
  readonly list: (chat: Chat) => Effect.Effect<Pacer.Identities, Error>
  /** Links the chat to an identity of its project, to the one another chat is now, or with `new` to its own again. */
  readonly link: (chat: Chat, to: Pacer.IdentityLink) => Effect.Effect<Pacer.IdentityLinked, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerIdentity") {}

export const NOT_OFFERED = "This CLIProxyPacer keeps no agents' identities yet."
export const ONE_TARGET = "Name one identity, one session, or new."

// CPP's shapes (`GET /pacer/v1/projects/{identity}/identities`, the `identity` event's answer).
const Wire = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  person: Schema.NullishOr(Schema.String),
  part: Schema.String,
  role: Schema.String,
  title: Schema.NullishOr(Schema.String),
  parent: Schema.NullishOr(Schema.String),
  chats: Schema.Array(
    Schema.Struct({
      session: Schema.String,
      chat: Schema.String,
      since: Schema.Finite,
      how: Schema.Literals(["made", "linked", "own"]),
      current: Schema.Boolean,
    }),
  ),
  open_tasks: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, state: Schema.String })),
  made_at: Schema.Finite,
  last_active: Schema.NullishOr(Schema.Finite),
})
type Wire = typeof Wire.Type
const ListAnswer = Schema.Struct({ identities: Schema.Array(Wire) })
const LinkAnswer = Schema.Struct({ identity: Wire, changed: Schema.Boolean })

/** A UUID as CPP names a chat (`X-Pacer-Session`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const models = yield* PacerModels.Service
    const badges = yield* PacerBadges.Service

    const offered = Effect.map(models.get(), (catalog) => catalog?.pacer?.memory?.identities === true)
    const refuseUnoffered = Effect.flatMap(offered, (yes) =>
      yes ? Effect.void : Effect.fail(new Refused({ reason: NOT_OFFERED })),
    )
    const headers = (chat: Chat) =>
      PacerHeaders.chat({
        sessionID: chat.sessionID,
        parentID: chat.parentID,
        project: chat.headers,
        agent: chat.agent,
      })

    return Service.of({
      features: () =>
        Effect.map(models.get(), (catalog) => ({
          identities: catalog?.pacer?.memory?.identities === true,
          badges: catalog?.pacer?.memory?.badges === true,
        })),

      list: Effect.fn("PacerIdentity.list")(function* (chat: Chat) {
        yield* refuseUnoffered
        const answer = yield* http
          .get(`/pacer/v1/projects/${encodeURIComponent(chat.project)}/identities`, ListAnswer, {
            headers: headers(chat),
            failover: true,
          })
          .pipe(Effect.mapError(failure))
        const own = PacerSessionID.make(chat.sessionID)
        const skew = skewOf(answer.offset)
        const items = answer.body.identities.map((item) => identityOf(item, skew))
        const current = answer.body.identities.find((item) =>
          item.chats.some((joined) => joined.current && joined.session === own),
        )
        return { items, ...(current ? { current: current.id } : {}) }
      }),

      link: Effect.fn("PacerIdentity.link")(function* (chat: Chat, to: Pacer.IdentityLink) {
        yield* refuseUnoffered
        const identity = to.identity?.trim()
        const session = to.session?.trim()
        const wanted = [identity ? 1 : 0, session ? 1 : 0, to.new === true ? 1 : 0].reduce((a, b) => a + b, 0)
        if (wanted !== 1) return yield* new Refused({ reason: ONE_TARGET })
        const target = identity
          ? { identity }
          : session
            ? { session: UUID.test(session) ? session.toLowerCase() : PacerSessionID.make(session as SessionID) }
            : { new: true }
        const answer = yield* http
          .post(
            `/pacer/v1/sessions/${encodeURIComponent(PacerSessionID.make(chat.sessionID))}/events`,
            { type: "identity", ...target },
            LinkAnswer,
            { headers: headers(chat) },
          )
          .pipe(Effect.mapError(failure))
        // The chat now shows the badge of the identity it is linked to.
        if (answer.body.changed) yield* badges.forget(chat.sessionID)
        return { identity: identityOf(answer.body.identity, skewOf(answer.offset)), changed: answer.body.changed }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [PacerHttp.node, PacerModels.node, PacerBadges.node],
})

/** CPP's clock minus this one's, from an answer's `Date`; 0 without one. */
function skewOf(offset: PacerHttp.Offset | undefined) {
  return offset === undefined ? 0 : Math.round((offset.low + offset.high) / 2)
}

function identityOf(item: Wire, skew: number): Pacer.Identity {
  return {
    id: item.id,
    name: item.name,
    ...(item.person ? { person: item.person } : {}),
    part: item.part,
    role: item.role,
    ...(item.title ? { title: item.title } : {}),
    ...(item.parent ? { parent: item.parent } : {}),
    chats: item.chats.map((chat) => ({
      chat: chat.chat,
      how: chat.how,
      since: chat.since - skew,
      current: chat.current,
    })),
    openTasks: item.open_tasks.map((task) => ({ id: task.id, title: task.title, state: task.state })),
    ...(item.last_active == null ? {} : { lastActive: item.last_active - skew }),
    madeAt: item.made_at - skew,
  }
}

/** CPP's refusals in its own words, which are written for a person; the rest as unavailable. */
function failure(error: PacerHttp.Error): Error {
  if (error._tag === "PacerHttp.NoPacer" && error.type === "project_memory_off")
    return new Refused({ reason: "Memory is off for this chat's project, so it has no agents' identities." })
  if (error._tag === "PacerHttp.Refused" && error.type === "project_forbidden")
    return new Refused({ reason: "This key may not use this project's memory, nor its agents' identities." })
  if (error._tag === "PacerHttp.NoPacer" && (error.type === "unknown_session" || error.type === "unknown_identity"))
    return new Refused({ reason: sentence(error.reason) })
  if (error._tag === "PacerHttp.Unexpected" && (error.status === 400 || error.status === 409))
    return new Refused({ reason: sentence(error.reason) })
  return new Unavailable({ reason: error.message })
}

/** CPP's message as a sentence: its first letter up, a full stop at its end. */
function sentence(text: string) {
  const trimmed = text.trim()
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}`
}
