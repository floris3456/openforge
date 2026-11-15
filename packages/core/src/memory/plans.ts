export * as MemoryPlans from "./plans.js"

import { eq, sql } from "drizzle-orm"
import { Context, type Duration, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import { Permission } from "../permission.js"
import { SessionEvent } from "../session/event.js"
import { PromptStartTable, PromptToolsTable } from "../session/prompt-start.sql.js"
import type { SessionSchema } from "../session/schema.js"
import { Wildcard } from "../util/wildcard.js"
import { MemoryClient } from "./client.js"
import { MemoryOffer } from "./offer.js"
import { MemoryTask } from "./task.js"
import { MemoryTexts } from "./texts.js"

// Task plans (the workspace's spec `docs/specs/task-plans.md`, sections 6 and 8), where a chat has CPP's `task` tool:
// an edit outside a task changes nothing (`TaskPlansPlugin`), and a turn that changed something without a task call
// ends with one check. When they apply is openforge's; their words and which task the check names are CPP's (workspace
// reference `docs/reference/cpp-tools-api.md`). What a chat works under is frozen per span, as its tools are: its tools
// are those recorded at its latest cold point (`SessionPromptStart`), with its start block in view. A chat without the
// tool cannot make a task, so nothing of this applies to it.

export interface Interface {
  /**
   * Whether the chat works under task plans: its start block in view was built while memory could be reached, and the
   * tools of its latest cold point hold `task`, which it can call now. Never fails.
   */
  readonly planned: (session: SessionSchema.Info) => Effect.Effect<boolean>
  /** CPP's task check for the chat, or null when its task or subtask is not active; the chat's place follows CPP's. */
  readonly check: (session: SessionSchema.Info) => Effect.Effect<string | null, MemoryClient.Error>
  /**
   * What an edit outside a task answers, when the chat could make a task now: one read of its place within
   * {@link REACH}. Undefined otherwise, so that a chat is never locked out of editing while memory cannot be reached.
   * Never fails.
   */
  readonly refusal: (session: SessionSchema.Info) => Effect.Effect<string | undefined>
}

/** How long the read that says whether memory can be reached may take before an edit goes ahead. */
export const REACH = "2 seconds"

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryPlans") {}

type Db = Database.Interface["db"]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    const client = yield* MemoryClient.Service
    const projects = yield* PacerProject.Service
    const agents = yield* Agent.Service
    const texts = yield* MemoryTexts.Service

    /** Whether the chat's agent may call `task`, for a chat whose start is not recorded (`freeze_prompt` off). */
    const allowed = Effect.fnUntraced(function* (session: SessionSchema.Info) {
      const agent = (yield* agents.select(session.agent)).info
      if (!agent) return false
      const rule = Permission.merge(agent.permissions, session.permissions ?? []).findLast((rule) =>
        Wildcard.match("task", rule.action),
      )
      return !(rule?.resource === "*" && rule.effect === "deny")
    })

    /** The chat's place as CPP says it, copied into its metadata when it moved, and the check's line. */
    const chat = Effect.fnUntraced(function* (session: SessionSchema.Info, timeout?: Duration.Input) {
      const named = yield* projects.chat(session.projectID)
      if (named.project === undefined) return undefined
      const answer = yield* client
        .withHeaders(
          PacerHeaders.chat({
            sessionID: session.id,
            parentID: session.parentID,
            project: named.headers,
            agent: String(session.agent),
          }),
        )
        .chat(named.project, timeout === undefined ? undefined : { timeout })
      if (answer.place !== undefined) {
        const place = MemoryTask.fromPlace(answer.place)
        if (!MemoryTask.at(session.metadata, place))
          yield* bus.publish(SessionEvent.MetadataUpdated, {
            sessionID: session.id,
            metadata: MemoryTask.placed(session.metadata, place),
          })
      }
      return answer
    })

    return Service.of({
      planned: Effect.fn("MemoryPlans.planned")(function* (session) {
        // Without the server, or on one that serves no memory now, the task tool answers that memory is unavailable.
        if ((yield* endpoints.get()) === undefined) return false
        const catalog = yield* catalogs.get()
        if (catalog && catalog.pacer?.memory?.tools !== true) return false
        const block = yield* MemoryOffer.newestBlock(db, session.id)
        if (!block?.visible || block.unavailable) return false
        return (yield* recorded(db, session.id)) ?? (yield* allowed(session))
      }),
      check: Effect.fn("MemoryPlans.check")(function* (session) {
        return (yield* chat(session))?.check ?? null
      }),
      refusal: Effect.fn("MemoryPlans.refusal")(function* (session) {
        const refused = (yield* texts.get())?.refused
        if (refused === undefined) return undefined
        const answer = yield* chat(session, REACH).pipe(
          Effect.catch((error) =>
            Effect.logWarning("memory cannot be reached, so an edit outside a task goes ahead", {
              sessionID: session.id,
              reason: error.message,
            }).pipe(Effect.as(undefined)),
          ),
        )
        // CPP may know the chat inside a task its metadata did not say yet.
        if (answer === undefined || answer.place) return undefined
        return refused
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    Database.node,
    PacerEndpoint.node,
    PacerModels.node,
    MemoryClient.node,
    MemoryTexts.node,
    PacerProject.node,
    Agent.node,
  ],
})

/**
 * Whether the tools recorded at the chat's latest cold point hold `task`; undefined when none are recorded. One lookup,
 * which reads the recorded definitions in the database without decoding them here.
 */
const recorded = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID) {
  const row = yield* db
    .select({
      task: sql<number>`exists (select 1 from ${PromptToolsTable}, json_each(${PromptToolsTable.value}) where ${PromptToolsTable.hash} = ${PromptStartTable.tools} and json_extract(json_each.value, '$.name') = 'task')`,
    })
    .from(PromptStartTable)
    .where(eq(PromptStartTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : row.task === 1
})
