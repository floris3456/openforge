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
  /** Where the chat works (`PacerWhere`). */
  readonly where?: string
  /** The agent the request runs as ({@link agent}). */
  readonly agent?: string
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
    ...chat({ ...input, agent: undefined }),
    ...agent(input.agent),
    ...(kind === "primary"
      ? { "X-Pacer-Compact": input.auto ? "auto, cold, before-cold" : "before-cold" }
      : { "X-Pacer-Kind": kind }),
  }
}

/**
 * The chat a request belongs to, its parent for a subagent, and its project: on model requests, tool list reads, tool
 * calls and memory calls. With `agent`, as a tool call and memory's texts name who asks (workspace reference
 * `docs/reference/cpp-tools-api.md`, "Who is asking"): the agent as its role, and the chat by its own id.
 */
export function chat(input: {
  readonly sessionID: SessionID
  readonly parentID?: SessionID
  readonly project?: Readonly<Record<string, string>>
  readonly agent?: string
  readonly where?: string
}) {
  return {
    "X-Pacer-Session": PacerSessionID.make(input.sessionID),
    ...(input.parentID ? { "X-Pacer-Parent-Session": PacerSessionID.make(input.parentID) } : {}),
    ...input.project,
    ...(input.agent === undefined ? {} : { ...agent(input.agent), "X-Pacer-Chat": input.sessionID }),
    ...where(input.where),
  }
}

/**
 * The agent a chat runs as (build, explore, a person's own), its role to CPP: on model requests and tool list reads,
 * which name the chat by `X-Pacer-Session` alone (workspace spec `docs/specs/agent-tools.md`, section 2).
 */
export function agent(name: string | undefined): Readonly<Record<string, string>> {
  return name === undefined ? {} : { "X-Pacer-Agent": name }
}

export const WHERE = "X-Pacer-Where"

/**
 * Where the chat works (`PacerWhere`): on every request for a chat. The model request passes it to {@link make};
 * `PacerHttp` adds it to each request that names a chat by `X-Pacer-Session`.
 */
export function where(value: string | undefined): Readonly<Record<string, string>> {
  return value === undefined || value === "" ? {} : { [WHERE]: value }
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
