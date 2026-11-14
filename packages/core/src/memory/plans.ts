export * as MemoryPlans from "./plans.js"

import { eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Agent } from "../agent.js"
import { Database } from "../database/database.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import { Permission } from "../permission.js"
import { PromptStartTable, PromptToolsTable } from "../session/prompt-start.sql.js"
import type { SessionSchema } from "../session/schema.js"
import { Wildcard } from "../util/wildcard.js"
import { MemoryClient } from "./client.js"
import { MemoryOffer } from "./offer.js"
import type { MemoryTask } from "./task.js"

// Task plans (the workspace's spec `docs/specs/task-plans.md`, sections 5, 6 and 8), where a chat has the `task` tool on
// a server with plans: an edit outside a task changes nothing (`TaskPlansPlugin`), a turn that changed something
// without a task call ends with one check, and a chat's start block shows the project's other tasks (`MemoryStart`).
// What a chat works under is frozen per span, as its tools are: the start block in view records `plans`, and its tools
// are those recorded at its latest cold point (`SessionPromptStart`). A chat without the tool cannot make a task, so
// nothing of this applies to it.

export interface Interface {
  /**
   * Whether the chat works under task plans: its start block in view was built on a server with plans, and the tools
   * of its latest cold point hold `task`, which it can call now. Never fails.
   */
  readonly planned: (session: SessionSchema.Info) => Effect.Effect<boolean>
  /**
   * What a chat inside a task is on, from one read of the task: its subtask, or else the task's active subtask, or else
   * the task itself.
   */
  readonly current: (
    session: SessionSchema.Info,
    inside: MemoryTask.Inside,
  ) => Effect.Effect<MemoryClient.Task | undefined, MemoryClient.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryPlans") {}

type Db = Database.Interface["db"]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    const client = yield* MemoryClient.Service
    const projects = yield* PacerProject.Service
    const agents = yield* Agent.Service

    /** Whether the chat's agent may call `task`, for a chat whose start is not recorded (`freeze_prompt` off). */
    const allowed = Effect.fnUntraced(function* (session: SessionSchema.Info) {
      const agent = (yield* agents.select(session.agent)).info
      if (!agent) return false
      const rule = Permission.merge(agent.permissions, session.permissions ?? []).findLast((rule) =>
        Wildcard.match("task", rule.action),
      )
      return !(rule?.resource === "*" && rule.effect === "deny")
    })

    return Service.of({
      planned: Effect.fn("MemoryPlans.planned")(function* (session) {
        // Without the server, or on one that lost tasks, the task tool answers that memory is unavailable.
        if ((yield* endpoints.get()) === undefined) return false
        const catalog = yield* catalogs.get()
        if (catalog && !catalog.pacer?.memory?.tasks) return false
        const block = yield* MemoryOffer.newestBlock(db, session.id)
        if (!block?.visible || !block.tasks || !block.plans) return false
        return (yield* recorded(db, session.id)) ?? (yield* allowed(session))
      }),
      current: Effect.fn("MemoryPlans.current")(function* (session, inside) {
        const chat = yield* projects.chat(session.projectID)
        if (chat.project === undefined) return undefined
        const read = yield* client
          .withHeaders(PacerHeaders.chat({ sessionID: session.id, parentID: session.parentID, project: chat.headers }))
          .task(chat.project, inside.task)
        const subtask = inside.subtask
          ? read.subtasks.find((item) => item.id === inside.subtask)
          : read.subtasks.find((item) => item.state === "active")
        return subtask ?? read.task
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, PacerEndpoint.node, PacerModels.node, MemoryClient.node, PacerProject.node, Agent.node],
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

/** What an edit, a write or a patch answers in a chat in no task: nothing was changed. */
export function refused(lead: boolean) {
  return lead
    ? "This chat is in no task, so nothing was changed. Make the task first with the task tool (its summary and the subtasks you now believe in), then make the change."
    : "This chat is in no task, so nothing was changed, and a subagent makes none: stop and answer that your lead must make the task first and start you with its taskID."
}

/** The start block's line for a chat in no task. */
export function outside(lead: boolean) {
  return lead
    ? "This chat is in no task: before changing anything, make one with the task tool."
    : "This chat is in no task, and a subagent makes none: before changing anything, answer that your lead must make the task and start you with its taskID."
}

/**
 * The check at the end of a turn that changed something without a task call: one line. A subagent's lead gets only
 * its last message, which would then be its answer to this.
 */
export function check(item: MemoryClient.Task, lead: boolean) {
  const line = `Task check: [${item.id}] ${item.title} is still active. Mark what is now true with the task tool (done starts the next subtask, plan replaces those not started, blocked says what is wrong), or answer that it goes on.`
  return lead ? line : `${line} Then give your answer again: your lead reads only your last message.`
}

/** How many tasks each group of the start block lists at most. */
export const LISTED = 10

/**
 * The start block's lines on the project's other tasks, from its list: the active ones, and apart the idle ones, each
 * group the newest changed first and at most {@link LISTED}. The chat's own task is left out. The block is stored, so
 * the times are as they were when it was built.
 */
export function others(list: MemoryClient.TaskList, own: string | undefined, now: number) {
  const top = list.tasks.filter((item) => !item.parent && item.state === "active" && item.id !== own)
  const working = top
    .filter((item) => !item.idle)
    .map((item) => {
      const subtask = list.tasks
        .filter((sub) => sub.parent === item.id && sub.state === "active")
        .toSorted((left, right) => right.changed - left.changed)[0]
      const at = subtask?.changed ?? item.changed
      return {
        at,
        line: `- [${item.id}] ${item.title} (${who(item.worker ?? item.by)}${subtask ? `; now [${subtask.id}] ${subtask.title}` : ""}; changed ${ago(now, at)})`,
      }
    })
  const idle = top
    .filter((item) => item.idle)
    .map((item) => ({
      at: item.worker_seen ?? item.changed,
      line: `- [${item.id}] ${item.title} (${who(item.worker ?? item.by)}; ${item.worker_seen ? `last model request ${ago(now, item.worker_seen)}` : `changed ${ago(now, item.changed)}`})`,
    }))
  return [
    ...group("Other active tasks of this project, the newest changed first:", working),
    ...group(
      "Idle tasks of this project (idle: no model request from its chat for 24 hours; not work in progress; a lead may close it, its note naming the evidence):",
      idle,
    ),
  ]
}

function group(head: string, items: ReadonlyArray<{ readonly at: number; readonly line: string }>) {
  if (items.length === 0) return []
  const sorted = items.toSorted((left, right) => right.at - left.at)
  return [
    head,
    ...sorted.slice(0, LISTED).map((item) => item.line),
    ...(sorted.length > LISTED ? [`and ${sorted.length - LISTED} more: task() lists them.`] : []),
  ]
}

function who(by: { readonly person: string; readonly role: string }) {
  return `${by.person} as ${by.role}`
}

/** How long before `now` a time was, as the block says it: in minutes, then hours, then days. */
export function ago(now: number, at: number) {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}
