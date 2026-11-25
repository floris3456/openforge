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
// 2026-11-25): a helper on a step hands its pictures in on the step, checked against when the step went active, and a
// refusal always asks for the items on the call's own task or step. Without `step_items` a step's items could only go
// on its task, whose open round may be a lead's hand-in waiting for the person, so a chat on a step and a call on a
// step are never refused there.

/** How long the read of the chat's task may take; without an answer the call goes as before. */
export const READ = "5 seconds"
/** How many pictures a refusal names. */
export const NAMED = 20

export interface Interface {
  /**
   * Why `input`, a call of CPP's task tool by `session` as `agent` (its role), is not sent ({@link refusedText}): the
   * pictures it should hand in as items, and how. Undefined when it goes: a lead's, one with items or that hands nothing
   * in, on a server without review items, one on a step where steps take no items, or when its task or step cannot be
   * read (logged). Never fails.
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
      // Where steps take no items, a step's could only go on its task, where they could replace a lead's hand-in.
      if (memory.stepItems !== true && (inside.subtask !== undefined || id !== inside.task)) return undefined
      // A chat on a step hands in only that step: its calls on another step or on the task go.
      if (inside.subtask !== undefined && id !== inside.subtask) return undefined
      const began = DateTime.toEpochMillis(session.time.created)
      const calls = yield* callsSince(session.id, began)
      // Most hand-ins looked at no picture: they go without a read of the task.
      if (!calls.some((call) => call.pictures.length > 0)) return undefined
      const chat = yield* projects.session(session)
      if (chat.project === undefined) return undefined
      // What the chat works on, whose going active the pictures are counted from: its step, or its task.
      const own = inside.subtask ?? inside.task
      const kind = inside.subtask === undefined ? "task" : "step"
      const read = yield* client
        .withHeaders(
          PacerHeaders.chat({ sessionID: session.id, parentID: session.parentID, project: chat.headers, agent }),
        )
        .task(chat.project, own, { timeout: READ })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`sent a helper's hand-in without knowing when its ${kind} went active`, {
              reason: error.message,
            }).pipe(Effect.as(undefined)),
          ),
        )
      if (read === undefined) return undefined
      if (inside.subtask === undefined) {
        const step = read.subtasks.find((subtask) => subtask.id === id)
        if (id !== inside.task && step === undefined) return undefined
        // On its task's step, done hands in only on the last open one, which sends the task to review.
        if (
          input.state === "done" &&
          (step === undefined || closed(step) || read.subtasks.some((other) => other !== step && !closed(other)))
        )
          return undefined
      }
      // A helper on a step of its lead's task, which went active long before, counts from its own start.
      const moment = Math.max(wentActive(read), began)
      const since = calls.filter((call) => call.at >= moment)
      if (since.some((call) => gaveItems(call, [id, own]))) return undefined
      const pictures = yield* changedAfter(since, moment)
      if (pictures.length === 0) return undefined
      return refusedText(kind, own, pictures)
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
 * and that the ones showing the work go as items in the call itself, on its own task or step.
 */
export function refusedText(kind: "task" | "step", id: string, pictures: ReadonlyArray<string>) {
  const more = pictures.length - NAMED
  const named = `${pictures.slice(0, NAMED).join(", ")}${more > 0 ? ` and ${more} more` : ""}`
  return [
    `since ${kind} ${id} went active you looked at pictures changed after that: ${named}.`,
    "Work that made pictures goes to review with them as items:",
    "send this again with items, those that show the work, each {picture, comment} saying what it shows and what to judge.",
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

/** Whether `call` gave one of `tasks` items, and was not refused. */
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

/** When the task last went active: its newest change to active that is no edit, else when it was made. */
function wentActive(read: MemoryClient.TaskRead) {
  const change = read.changes.find(
    (change) => change.state === "active" && (change.title ?? null) === null && (change.description ?? null) === null,
  )
  return change?.at ?? read.task.at
}
