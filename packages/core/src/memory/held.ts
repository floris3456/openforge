export * as MemoryHeld from "./held.js"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Agent } from "../agent.js"
import { Database } from "../database/database.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import { PacerTools } from "../pacer/tools.js"
import { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { MemoryClient } from "./client.js"
import { MemoryHeldTable } from "./held.sql.js"

// Board reviews first (the workspace's task khtzd8a7qje3; the owner, 2026-11-25: "Of course force it right? ... it makes
// sure that the agent creates proper annotations that both me and the child can read rather than doing something
// random"): a lead's message to its helper waits while a round the helper handed in holds a picture or text with neither
// the person's answer nor this lead's, until a task tool call of the lead's leaves nothing owed (`SubagentTool`). What
// is owed is CPP's to say (`GET …/owed`, while its capabilities say `review_owed`); the hold and its words are
// openforge's. A held message waits in its own table, not in the helper's inbox, whose delivery rules stay upstream's:
// it enters the inbox, as any message to a helper does, once it is released.

/** How long the read of what a lead owes may take; without an answer the message goes as before. */
export const READ = "5 seconds"

/** The subagent call that was held, as the lead wrote it. */
export const Input = Schema.Struct({
  agent: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  model: Schema.optionalKey(Schema.String),
  taskID: Schema.optionalKey(Schema.String),
})
export interface Input extends Schema.Schema.Type<typeof Input> {}
const decodeInput = Schema.decodeUnknownOption(Input)

/** A message held for a helper. */
export interface Held {
  readonly helper: SessionSchema.ID
  readonly lead: SessionSchema.ID
  /** The id it enters the helper's inbox with, so a release tried again after a stop admits it once. */
  readonly messageID: SessionMessage.ID
  readonly input: Input
}

export interface Interface {
  /**
   * What `lead` owes `helper`: the open rounds the helper handed in, on tasks the lead handled, with their pictures and
   * texts that have neither the person's answer nor the lead's, as CPP answers it. None without `review_owed`, for a
   * chat with a parent (only a lead answers a round) or one whose tools hold no `task`, outside a project, or when CPP
   * does not answer (logged), so a message is never held for a read that failed. Never fails.
   */
  readonly owed: (
    lead: SessionSchema.Info,
    helper: SessionSchema.Info,
  ) => Effect.Effect<ReadonlyArray<MemoryClient.Owed>>
  /** Holds `input` for `helper`, in place of the message held for it before. */
  readonly hold: (lead: SessionSchema.ID, helper: SessionSchema.ID, input: Input) => Effect.Effect<Held>
  /** Drops the message held for `helper`, or only the one of `messageID`. */
  readonly drop: (helper: SessionSchema.ID, messageID?: SessionMessage.ID) => Effect.Effect<void>
  /** The messages `lead` holds, oldest first. */
  readonly held: (lead: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Held>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryHeld") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const catalogs = yield* PacerModels.Service
    const projects = yield* PacerProject.Service
    const client = yield* MemoryClient.Service
    const agents = yield* Agent.Service
    const calls = yield* PacerTools.Service

    const owed = Effect.fn("MemoryHeld.owed")(function* (lead: SessionSchema.Info, helper: SessionSchema.Info) {
      const memory = (yield* catalogs.get())?.pacer?.memory
      if (memory?.reviewOwed !== true || memory.tools !== true || lead.parentID !== undefined) return []
      // A lead without the task tool could never answer: its messages are never held.
      if (calls.holds(lead.id, "task") !== true) return []
      const chat = yield* projects.chat(lead.projectID)
      if (chat.project === undefined) return []
      const role = String((yield* agents.select(lead.agent)).id)
      return yield* client
        .withHeaders(PacerHeaders.chat({ sessionID: lead.id, project: chat.headers, agent: role }))
        .owed(chat.project, helper.id, { timeout: READ })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("sent a lead's message to its helper without knowing what it owes", {
              reason: error.message,
            }).pipe(Effect.as([])),
          ),
        )
    })

    return Service.of({
      owed,
      hold: Effect.fn("MemoryHeld.hold")(function* (lead, helper, input) {
        const held = { helper, lead, messageID: SessionMessage.ID.create(), input }
        const row = { lead_id: lead, message_id: held.messageID, input, time_created: Date.now() }
        yield* db
          .insert(MemoryHeldTable)
          .values({ helper_id: helper, ...row })
          .onConflictDoUpdate({ target: MemoryHeldTable.helper_id, set: row })
          .run()
          .pipe(Effect.orDie)
        return held
      }),
      drop: (helper, messageID) =>
        db
          .delete(MemoryHeldTable)
          .where(
            messageID === undefined
              ? eq(MemoryHeldTable.helper_id, helper)
              : and(eq(MemoryHeldTable.helper_id, helper), eq(MemoryHeldTable.message_id, messageID)),
          )
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      held: (lead) =>
        db
          .select()
          .from(MemoryHeldTable)
          .where(eq(MemoryHeldTable.lead_id, lead))
          .orderBy(asc(MemoryHeldTable.time_created))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) =>
              rows.flatMap((row) =>
                Option.toArray(decodeInput(row.input)).map((input) => ({
                  helper: row.helper_id,
                  lead: row.lead_id,
                  messageID: row.message_id,
                  input,
                })),
              ),
            ),
          ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, PacerModels.node, PacerProject.node, PacerTools.node, MemoryClient.node, Agent.node],
})

/** The lead's tool answer when its message to its helper is held: the rounds and items it owes, and what to do. */
export function heldText(owed: ReadonlyArray<MemoryClient.Owed>) {
  const rounds = owed.map((round) => `task ${round.task} "${round.title}", round ${round.round}: ${items(round.items)}`)
  return [
    `Held, not sent: this helper handed in work for review that neither you nor the person has answered (${rounds.join("; ")}).`,
    "Answer each item with the task tool's marks first: pass, deny or dismiss, and a note with words on what you deny. This message goes to the helper right after that call; a newer message to it replaces this one.",
  ].join("\n")
}

/** What a lead's task call answers after it, for a held message the call released. */
export function sentText(held: Held) {
  return `Your held message to subagent ${held.helper} ("${held.input.description}") is sent now, after this call. You will receive a <subagent> message when it goes idle.`
}

/** What a lead's task call answers after it, for a held message that could not be sent once released. */
export function failedText(held: Held, reason: string) {
  return `Your held message to subagent ${held.helper} ("${held.input.description}") could not be sent: ${reason}. Send it again with the subagent tool.`
}

/** `item 1 after.png`, `items 1 after.png and 2 spec.md`, `items 1 a.png, 2 b.png and 3 c.md`. */
function items(list: MemoryClient.Owed["items"]) {
  const named = list.map((item) => `${item.n} ${item.name}`)
  if (named.length === 1) return `item ${named[0]}`
  return `items ${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
}
