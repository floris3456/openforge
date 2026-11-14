export * as PacerHeaders from "./headers.js"

import { Schema } from "effect"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { ConfigMemory } from "@opencode/schema/config/memory"
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
   * Whether the chat compacts automatically. Only then does a step announce `auto` and `cold`, the asks to compact
   * before CPP moves the chat and to compact a cold, large chat first: CPP's guide says to send only the asks the
   * client acts on.
   */
  readonly auto: boolean
  /** The chat's project headers ({@link project}); none for a chat outside any project. */
  readonly project?: Readonly<Record<string, string>>
}

/**
 * CPP's request headers (its CLIENT-GUIDE, "Request headers"); none for another provider. The chat and its parent
 * by their UUIDs, and its project; `title` on titles and one-off generations, which then never bind, warm, move or ping the chat;
 * `compaction` on summaries; and the compaction asks a step acts on. upstream's `x-opencode-*` headers stay.
 */
export function make(input: Input): Readonly<Record<string, string>> {
  if (input.providerID !== provider) return {}
  const kind = input.kind === "title" || input.kind === "generate" ? "title" : input.kind
  return {
    ...chat(input),
    ...(kind === "primary"
      ? { "X-Pacer-Compact": input.auto ? "auto, cold, before-cold" : "before-cold" }
      : { "X-Pacer-Kind": kind }),
  }
}

/**
 * The chat a request belongs to, its parent for a subagent, and its project: on model requests, tool list reads and
 * tool calls.
 */
export function chat(input: {
  readonly sessionID: SessionID
  readonly parentID?: SessionID
  readonly project?: Readonly<Record<string, string>>
}) {
  return {
    "X-Pacer-Session": PacerSessionID.make(input.sessionID),
    ...(input.parentID ? { "X-Pacer-Parent-Session": PacerSessionID.make(input.parentID) } : {}),
    ...input.project,
  }
}

/** What CPP shows a project as: its name, and its normalised remote when it has one. */
export interface Place {
  readonly name: string
  readonly remote?: string
}

const identity = Schema.is(ConfigMemory.Project)

/**
 * The headers that name a chat's project to CPP (workspace spec `docs/specs/cpp-projects.md`, "The wire"): the identity
 * (the rule of memory's `{project}`), its name (at most 200 characters) and its remote, both percent-encoded. None for
 * an identity outside the rule, which CPP would ignore.
 */
export function project(id: string, place: Place): Readonly<Record<string, string>> {
  if (!identity(id)) return {}
  return {
    "X-Pacer-Project": id,
    "X-Pacer-Project-Name": encodeURIComponent([...place.name.toWellFormed()].slice(0, 200).join("")),
    ...(place.remote ? { "X-Pacer-Project-Remote": encodeURIComponent(place.remote.toWellFormed()) } : {}),
  }
}
