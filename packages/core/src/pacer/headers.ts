export * as PacerHeaders from "./headers.js"

import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import type { SessionID } from "@opencode/schema/session-id"
import { PacerSessionID } from "./session-id.js"

/** The provider these headers go to; `PacerEndpoint.id` as a plain string, so this module stays free of services. */
const provider = "cliproxypacer"

export interface Input {
  readonly providerID: string
  readonly kind: SessionRequestKind
  readonly sessionID: SessionID
  readonly parentID?: SessionID
  /**
   * Whether the chat compacts automatically. Only then does a step announce `auto`, the ask to compact before CPP
   * moves the chat: CPP's guide says to send only the asks the client acts on.
   */
  readonly auto: boolean
}

/**
 * CPP's request headers (its CLIENT-GUIDE, "Request headers"); none for another provider. The chat and its parent
 * by their UUIDs; `title` on titles and one-off generations, which then never bind, warm, move or ping the chat;
 * `compaction` on summaries; and the compaction asks a step acts on. upstream's `x-opencode-*` headers stay.
 */
export function make(input: Input): Readonly<Record<string, string>> {
  if (input.providerID !== provider) return {}
  const kind = input.kind === "title" || input.kind === "generate" ? "title" : input.kind
  return {
    "X-Pacer-Session": PacerSessionID.make(input.sessionID),
    ...(input.parentID ? { "X-Pacer-Parent-Session": PacerSessionID.make(input.parentID) } : {}),
    ...(kind === "primary"
      ? { "X-Pacer-Compact": input.auto ? "auto, before-cold" : "before-cold" }
      : { "X-Pacer-Kind": kind }),
  }
}
