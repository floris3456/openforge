export * as PacerWarmth from "./warmth.js"

import { Context, Effect, Layer } from "effect"
import type { Pacer } from "@opencode/schema/pacer"
import type { SessionID } from "@opencode/schema/session-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

// Whether CPP last said each chat's prompt cache is warm, held where a step reads it: a chat's recorded start is kept
// till its cache goes cold (`SessionPromptStart`), and the connection, its only writer, depends on the session store
// the step is part of. Only what a view held says: a step reads nothing from CPP.

/** Chats held; past it the one written longest ago goes. */
export const CHATS = 1_000

export type Warmth = Pick<Pacer.Chat, "warm" | "warmUntil" | "coldAt" | "asOf">

export interface Interface {
  /** What the chat's view last read said of its cache; undefined when none was read this run. */
  readonly get: (sessionID: SessionID) => Effect.Effect<Warmth | undefined>
  /** The connection's: each view it holds, as it reads it. */
  readonly set: (chat: Warmth & Pick<Pacer.Chat, "sessionID">) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerWarmth") {}

export const layer = Layer.sync(Service, () => {
  const chats = new Map<SessionID, Warmth>()
  return Service.of({
    get: (sessionID) => Effect.sync(() => chats.get(sessionID)),
    set: (chat) =>
      Effect.sync(() => {
        chats.delete(chat.sessionID)
        chats.set(chat.sessionID, {
          warm: chat.warm,
          asOf: chat.asOf,
          ...(chat.warmUntil !== undefined ? { warmUntil: chat.warmUntil } : {}),
          ...(chat.coldAt !== undefined ? { coldAt: chat.coldAt } : {}),
        })
        if (chats.size > CHATS) chats.delete(chats.keys().next().value!)
      }),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
