export * as PacerNews from "./news.js"

import { Effect, Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import type { Session } from "../session.js"
import { SessionMessage } from "../session/message.js"
import { PacerSessionID } from "./session-id.js"

// Blocker news (the workspace's spec `docs/specs/blocker-tasks.md`, section 4.2; CPP's capability `memory.news`): CPP
// keeps one row per event and chat to tell, and names the chats with news on its key's change stream (`news`) and in
// its pending list (`GET /pacer/v1/news`), which the connection reads at each connect. The install that holds a chat
// claims its news, admits each item as a queued synthetic message, which starts a turn in an idle chat and reaches a
// busy one when its turn would end, and then acks it. Every install of the key hears the notice; another's lookup finds
// no such chat and claims nothing. An item claimed again (an ack lost) has the same message id, which the inbox takes
// once. Nothing runs on a timer.

/** A chat CPP names: its UUID (`sessions.ext`), and the client's own id of it when CPP knows it. */
export const Named = Schema.Struct({ session: Schema.String, chat: Schema.optional(Schema.NullOr(Schema.String)) })
export type Named = typeof Named.Type
/** `GET /pacer/v1/news`: the key's chats with news not told. */
export const Pending = Schema.Struct({ sessions: Schema.Array(Named) })

/** One news item as a claim answers it: its line for the TUI (`summary`) and the text the chat is told. */
export const Item = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  task: Schema.String,
  blocked: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.String,
  text: Schema.String,
})
export type Item = typeof Item.Type
/** `POST /pacer/v1/sessions/{uuid}/news`: the chat's news not told, oldest first, now claimed. */
export const Claimed = Schema.Struct({ items: Schema.Array(Item) })
/** `POST /pacer/v1/sessions/{uuid}/news/told`: how many were not told before. */
export const Told = Schema.Struct({ told: Schema.Number })
/** Most ids one ack names. */
export const ACKED = 100

const decodeNotice = Schema.decodeUnknownOption(Schema.fromJsonString(Pending))

/** The chats a `news` notice names; none from one it can't read. */
export function notice(data: string): ReadonlyArray<Named> {
  return Option.getOrUndefined(decodeNotice(data))?.sessions ?? []
}

/**
 * The session of this install CPP names: by the client's own id of it, else, named by its UUID alone (a subagent's
 * lead), by `held` (the connection's), the chats this process named lately, then the newest 200 sessions. Each must
 * have that UUID and be in this install's store: another install's chat, on this machine or another, is none.
 */
export const holder = Effect.fnUntraced(function* (sessions: Session.Interface, named: Named, held?: SessionID) {
  const uuid = named.session.toLowerCase()
  const stored = (id: string | null | undefined) =>
    typeof id === "string" && Schema.is(SessionID)(id) && PacerSessionID.make(id) === uuid
      ? sessions.get(id).pipe(
          Effect.map(() => id),
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.succeed(undefined)
  if (named.chat) return yield* stored(named.chat)
  for (const id of [held, PacerSessionID.session(uuid)]) {
    const found = yield* stored(id)
    if (found) return found
  }
  const page = yield* sessions.list({ limit: 200 }).pipe(Effect.orElseSucceed(() => ({ data: [] })))
  return page.data.find((info) => PacerSessionID.make(info.id) === uuid)?.id
})

/** Admits the item into the chat's inbox as a queued synthetic message, under an id of its own, and wakes the chat. */
export const admit = (sessions: Session.Interface, sessionID: SessionID, item: Item) =>
  sessions.synthetic({
    sessionID,
    id: SessionMessage.ID.make(`msg_pacer_news_${item.id}`),
    text: item.text,
    description: item.summary,
    metadata: { source: "pacer.news", id: item.id, kind: item.kind, task: item.task },
    delivery: "queue",
  })
