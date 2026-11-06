export * as PacerConnection from "./connection.js"

import { Pacer } from "@opencode/schema/pacer"
import type { SessionID } from "@opencode/schema/session-id"
import { Context, type Effect, Schema } from "effect"

// The service's one connection to CPP, which every TUI reads through the `pacer.*` routes of `server.experimental`.
// It follows CPP's change stream, reads the accounts, the chats' views and their requests, sets the chats' switches,
// and publishes the `pacer.*` events (`Pacer.Event`). The interface only, for now: its layer and node follow, and the
// node is registered once the real `PacerModels.node` is in. Fields may be added; none may be removed or renamed
// without the server's handler and the TUI.

/** CPP can't answer now: it isn't set up, is unreachable, or has no pacer, and nothing read before can stand in. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("PacerConnection.Unavailable", {
  state: Pacer.State,
  reason: Schema.String,
}) {
  override get message() {
    return `CLIProxyPacer can't answer: ${this.reason}`
  }
}

export interface RequestsInput {
  readonly filter: Pacer.Filter
  /** The `cursor` of the page before, for the next, older page. */
  readonly cursor?: string
  /** Rows per page: 50 when absent, at most 500. */
  readonly limit?: number
}

export interface Interface {
  /** The connection now. */
  readonly status: () => Effect.Effect<Pacer.Status>
  /** Every account the key sees, as last read; undefined before the first read since CPP was set up. */
  readonly accounts: () => Effect.Effect<Pacer.Accounts | undefined>
  /**
   * The chat's view: as last read while that is current, else read from CPP while the pacer is on, else as last read
   * (its `asOf` says when). Undefined when CPP knows nothing of the chat, or nothing was read while CPP can't answer.
   */
  readonly chat: (sessionID: SessionID) => Effect.Effect<Pacer.Chat | undefined>
  /** Sets the chat's switches on CPP and answers its view after the change. */
  readonly update: (sessionID: SessionID, input: Pacer.ChatUpdate) => Effect.Effect<Pacer.Chat, Unavailable>
  /** One page of the chat's requests with its subagents', newest first, read from CPP. */
  readonly requests: (sessionID: SessionID, input: RequestsInput) => Effect.Effect<Pacer.Requests, Unavailable>
  /**
   * What changed in one request's prompt (`Pacer.Request.id`): from the last 50 read, else read from CPP. Undefined
   * when CPP has no request with that ID for the key.
   */
  readonly prompt: (requestID: string) => Effect.Effect<Pacer.PromptChange | undefined, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerConnection") {}
