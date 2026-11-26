export * as MemoryHandIn from "./hand-in.js"

import { and, asc, eq, gte } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { isRecord } from "@opencode/util/record"
import { Database } from "../database/database.js"
import { Environment } from "../environment/index.js"
import { FileAccess } from "../file-access.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import { SessionHistory } from "../session/history.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable } from "../session/sql.js"
import { MemoryClient } from "./client.js"
import { MemoryTask } from "./task.js"

// Pictures in hand-ins (the workspace's spec `docs/specs/picture-hand-ins.md`, section 2; the owner, 2026-11-25:
// "option 1", "this is only true for pictures of course"): a helper's call of CPP's task tool that sends its task to
// review without items is not sent when, since its task went active, the chat looked at a local picture changed after
// that moment, a picture its work made. When its task went active is CPP's to say (`GET …/tasks/{id}`); what the chat
// looked at is its own history, each picture a tool's result named by the path it was read from. The rule and its words
// are openforge's. A lead is never refused, and a hand-in is never stopped by a read that failed.
//
// A step holds review rounds of its own on a server that says `step_items` (section 5, the lead's decision of
// 2026-11-25): a helper whose chat works on a step of its lead's task hands its pictures in on that step, and its
// `done` there is asked to go to review instead, so that its lead judges the step. Without `step_items` its items could
// only go on the lead's task, whose open round may be a lead's hand-in waiting for the person, so a chat on a step is
// never refused there. A helper whose chat works on its task itself hands in on the task, as above: that round is its
// hand-in, and its items on any of the task's steps go on it. CPP places a helper working through its own plan on its
// current step, as it places one started on a step, so such a helper is told by the task's read naming it the worker
// (the lead's decision of 2026-11-26). Either counts from its task's or step's last going active or back to todo, as a
// deny sends it; the chat's own notes on it, kept as changes to the same state, do not count.

/** How long the read of the chat's task may take; without an answer the call goes as before. */
export const READ = "5 seconds"
/** How many pictures a refusal names. */
export const NAMED = 20

export interface Interface {
  /**
   * Why `input`, a call of CPP's task tool by `session` as `agent` (its role), is not sent ({@link refusedText}): the
   * pictures it should hand in as items, and how. Undefined when it goes: a lead's, one with items or that hands nothing
   * in, on a server without review items, one of a chat on a step where steps take no items, or when its task or step
   * cannot be read (logged). Never fails.
   */
  readonly refusal: (session: SessionSchema.Info, agent: string, input: unknown) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryHandIn") {}

/** What a call of the chat's history was: when it was made, its tool and input, and the pictures its result held. */
interface Call {
  readonly at: number
  readonly tool: string
  readonly status: string
  readonly input?: unknown
  /** The names of its result's pictures, as the tool gave them: the path as written, for a file that was read. */
  readonly pictures: ReadonlyArray<string>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const catalogs = yield* PacerModels.Service
    const projects = yield* PacerProject.Service
    const client = yield* MemoryClient.Service
    const access = yield* FileAccess.Service
    const environment = yield* Environment.Service

    /** The chat's tool calls made since `since`, in order, a Code Mode script's own calls after it. */
    const callsSince = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, since: number) {
      // A step's calls are in its row or, once written as parts, in the part table: `withParts` puts them together.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "assistant"),
            gte(SessionMessageTable.time_updated, since),
          ),
        )
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      return (yield* SessionHistory.withParts(db, rows)).flatMap((row) =>
        ("content" in row.data && Array.isArray(row.data.content) ? row.data.content : [])
          .flatMap(callsOf)
          .filter((call) => call.at >= since),
      )
    })

    /** The pictures named by `calls`, first looked at first, that are local files changed after `moment`. */
    const changedAfter = Effect.fnUntraced(function* (calls: ReadonlyArray<Call>, moment: number) {
      const named = [...new Set(calls.flatMap((call) => call.pictures))]
      const found = yield* Effect.forEach(named, (name) =>
        access.resolve({ path: name }).pipe(
          Effect.flatMap((target) =>
            environment.files
              .stat(target.absolute)
              .pipe(
                Effect.map((info) => (info.type === "file" && info.mtimeMs > moment ? target.absolute : undefined)),
              ),
          ),
          Effect.orElseSucceed(() => undefined),
          Effect.map((absolute) => ({ name, absolute })),
        ),
      )
      // Two names of one file are one picture, named as first written.
      const seen = new Set<string>()
      return found.flatMap((picture) => {
        if (picture.absolute === undefined || seen.has(picture.absolute)) return []
        seen.add(picture.absolute)
        return [picture.name]
      })
    })

    const refusal = Effect.fn("MemoryHandIn.refusal")(function* (
      session: SessionSchema.Info,
      agent: string,
      input: unknown,
    ) {
      if (session.parentID === undefined || !isRecord(input) || typeof input.id !== "string") return undefined
      const id = input.id
      if ((input.state !== "review" && input.state !== "done") || gives(input)) return undefined
      const inside = MemoryTask.inside(session.metadata)
      if (inside === undefined) return undefined
      const memory = (yield* catalogs.get())?.pacer?.memory
      if (memory?.reviewItems !== true) return undefined
      const began = DateTime.toEpochMillis(session.time.created)
      const calls = yield* callsSince(session.id, began)
      // Most hand-ins looked at no picture: they go without a read of the task.
      if (!calls.some((call) => call.pictures.length > 0)) return undefined
      const chat = yield* projects.session(session)
      if (chat.project === undefined) return undefined
      const project = chat.project
      const named = client.withHeaders(
        PacerHeaders.chat({ sessionID: session.id, parentID: session.parentID, project: chat.headers, agent }),
      )
      const readOf = (own: string, kind: "task" | "step") =>
        named.task(project, own, { timeout: READ }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`sent a helper's hand-in without knowing when its ${kind} went active`, {
              reason: error.message,
            }).pipe(Effect.as(undefined)),
          ),
        )
      const task = yield* readOf(inside.task, "task")
      if (task === undefined) return undefined
      // CPP places a helper working through its own plan on its current step, as it places one started on a step of its
      // lead's task: the task's worker tells them apart. Its worker hands in on the task from any of its steps.
      const worker = task.task.worker?.chat === session.id
      const onTask = inside.subtask === undefined || worker
      const step = onTask ? task.subtasks.find((subtask) => subtask.id === id) : undefined
      if (onTask) {
        if (id !== inside.task && step === undefined) return undefined
        // On its task's step, done hands in only on the last open one, which sends the task to review.
        if (
          input.state === "done" &&
          (step === undefined || closed(step) || task.subtasks.some((other) => other !== step && !closed(other)))
        )
          return undefined
      }
      // A chat on a step of its lead's task hands in only that step, and only where steps take items: elsewhere they
      // could only go on the task, where they could replace the lead's hand-in. Its calls on another step or on the task
      // go.
      if (!onTask && (memory.stepItems !== true || id !== inside.subtask)) return undefined
      // What the chat works on, whose round its items go in and whose going active the pictures are counted from.
      const own = onTask ? inside.task : inside.subtask
      const kind = onTask ? "task" : "step"
      const read = onTask ? task : yield* readOf(own, kind)
      if (read === undefined) return undefined
      // A helper on a step of its lead's task, which went active long before, counts from its own start.
      const moment = Math.max(opened(read, session.id), began)
      const since = calls.filter((call) => call.at >= moment)
      // CPP puts the items a task's worker gives on one of its steps on the task.
      const given = worker ? [inside.task, ...task.subtasks.map((subtask) => subtask.id)] : [own]
      if (since.some((call) => gaveItems(call, given))) return undefined
      const pictures = yield* changedAfter(since, moment)
      if (pictures.length === 0) return undefined
      if (step !== undefined) return refusedText(kind, own, "first", pictures)
      return refusedText(kind, own, kind === "step" && input.state === "done" ? "review" : "again", pictures)
    })

    return Service.of({ refusal })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, PacerModels.node, PacerProject.node, MemoryClient.node, FileAccess.node, Environment.node],
})

/**
 * Why the call is not sent, after `Not sent: `: the pictures looked at since the chat's task or step `id` went active,
 * and how the ones showing the work go as items: in the call sent again (`again`), sent again for review (`review`, a
 * step's done, so that its lead judges it), or first on task `id`, then the call (`first`, a call on its step).
 */
export function refusedText(
  kind: "task" | "step",
  id: string,
  ask: "again" | "review" | "first",
  pictures: ReadonlyArray<string>,
) {
  const more = pictures.length - NAMED
  const named = `${pictures.slice(0, NAMED).join(", ")}${more > 0 ? ` and ${more} more` : ""}`
  const how = "each {picture, comment} saying what it shows and what to judge"
  return [
    `since ${kind} ${id} went active you looked at pictures changed after that: ${named}.`,
    "Work that made pictures goes to review with them as items:",
    ask === "first"
      ? `first give those that show the work as items on task ${id} (task with id ${id} and items, ${how}), then send this again.`
      : `send this again with ${ask === "review" ? 'state "review" and ' : ""}items, those that show the work, ${how}.`,
  ].join(" ")
}

const ToolPart = Schema.Struct({
  type: Schema.Literal("tool"),
  name: Schema.String,
  state: Schema.Struct({
    status: Schema.String,
    input: Schema.optional(Schema.Unknown),
    content: Schema.optional(Schema.Array(Schema.Unknown)),
    metadata: Schema.optional(Schema.Struct({ toolCalls: Schema.optional(Schema.Array(Schema.Unknown)) })),
  }),
  time: Schema.Struct({ created: Schema.Number }),
})
const decodeToolPart = Schema.decodeUnknownOption(ToolPart)
const decodePicture = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("file"), mime: Schema.String, name: Schema.String }),
)
// A Code Mode script's own calls, as its `execute` part's settled metadata keeps them (`CodeModeTool`'s rows).
const decodeInner = Schema.decodeUnknownOption(
  Schema.Struct({ tool: Schema.String, status: Schema.String, input: Schema.optional(Schema.Unknown) }),
)

/** A stored part's call, if it is a tool's, then the calls its script made, which share its time and leave it the pictures. */
function callsOf(stored: unknown): ReadonlyArray<Call> {
  const part = Option.getOrUndefined(decodeToolPart(stored))
  if (part === undefined) return []
  const at = part.time.created
  const pictures = (part.state.content ?? []).flatMap((item) =>
    Option.toArray(decodePicture(item)).flatMap((file) => (file.mime.startsWith("image/") ? [file.name] : [])),
  )
  const inner = (part.state.metadata?.toolCalls ?? []).flatMap((item) =>
    Option.toArray(decodeInner(item)).map((call) => ({ ...call, at, pictures: [] })),
  )
  return [{ at, tool: part.name, status: part.state.status, input: part.state.input, pictures }, ...inner]
}

/** Whether a call's input holds items: a list of them with an entry. */
function gives(input: Readonly<Record<string, unknown>>) {
  return [input.items, input.pictures].some((list) => Array.isArray(list) && list.length > 0)
}

/** Whether `call` gave one of the tasks `tasks` items, and was not refused. */
function gaveItems(call: Call, tasks: ReadonlyArray<string>) {
  return (
    call.tool === "task" &&
    call.status === "completed" &&
    isRecord(call.input) &&
    typeof call.input.id === "string" &&
    tasks.includes(call.input.id) &&
    gives(call.input)
  )
}

function closed(task: { readonly state: string }) {
  return task.state === "done" || task.state === "dropped"
}

/**
 * When the task last went active or back to todo, as a deny sends it: its newest such change that is no edit, made by
 * another chat than `chat` (a lead's new round) or changing the state (the next older change has another, or none is
 * listed), else when it was made. A note is kept as a change to the same state, and the chat's own notes on its active
 * task do not restart the moment. Its earlier rounds' items then no longer let a hand-in go.
 */
function opened(read: MemoryClient.TaskRead, chat: string) {
  const change = read.changes.find(
    (change, n) =>
      (change.state === "active" || change.state === "todo") &&
      (change.title ?? null) === null &&
      (change.description ?? null) === null &&
      (change.by?.chat !== chat || read.changes[n + 1]?.state !== change.state),
  )
  return change?.at ?? read.task.at
}
