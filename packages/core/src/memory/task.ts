export * as MemoryTask from "./task.js"

import { ToolFailure } from "@opencode/ai/effect"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Config } from "../config.js"
import { PacerModels } from "../pacer/models.js"
import type { SessionSchema } from "../session/schema.js"
import { MemoryClient } from "./client.js"
import { MemoryText } from "./text.js"

// Where a chat's task is kept (the workspace's spec `docs/specs/memory.md`, section 5): the session's metadata
// `memory: { task, subtask? }`, `task` always the task that has no parent. openforge sets it, never a model: the
// subagent tool's `taskID` for a new child, and the task tool when a chat sets a task active or done. A child inherits
// its parent's metadata when it is made.

/** The task a chat is inside, and the subtask of it. */
export const Inside = Schema.Struct({ task: Schema.String, subtask: Schema.optional(Schema.String) })
export interface Inside extends Schema.Schema.Type<typeof Inside> {}
const decodeInside = Schema.decodeUnknownOption(Inside)

/** The task the session's metadata says the chat is inside, if any. */
export function inside(metadata: SessionSchema.Metadata | undefined): Inside | undefined {
  const found = decodeInside(metadata?.memory)
  return found._tag === "Some" ? found.value : undefined
}

/** The metadata with the chat inside `place`, or inside no task when it is undefined. */
export function placed(
  metadata: SessionSchema.Metadata | undefined,
  place: Inside | undefined,
): SessionSchema.Metadata {
  const rest = Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => key !== "memory"))
  if (place === undefined) return rest
  const memory: Record<string, string> = place.subtask
    ? { task: place.task, subtask: place.subtask }
    : { task: place.task }
  return { ...rest, memory }
}

/** Where a chat that works on `task` is: inside it, or inside its parent and it. */
export function placeOf(task: MemoryClient.Task): Inside {
  return task.parent ? { task: task.parent, subtask: task.id } : { task: task.id }
}

/** A new child's task, read before the child is made. */
export interface Assigned {
  readonly project: string
  readonly task: MemoryClient.Task
  readonly inside: Inside
  /** The child's metadata: the parent's, inside the task. */
  readonly metadata: SessionSchema.Metadata
}

/** What the subagent tool asks of tasks (`taskID`); the rest of tasks is the task tool's. */
export interface Interface {
  /** Reads the task a new child is to work on; refused when it is unknown or this server has no tasks. */
  readonly assign: (parent: SessionSchema.Info, taskID: string) => Effect.Effect<Assigned, ToolFailure>
  /** Sets the task active in the child's name, before its first step. */
  readonly activate: (
    assigned: Assigned,
    child: { readonly id: string; readonly role: string },
  ) => Effect.Effect<void, ToolFailure>
  /** The child's answer with the task's state and note after it, when the task is no longer active. */
  readonly ended: (parent: SessionSchema.Info, taskID: string, output: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryTask") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* MemoryClient.Service
    const config = yield* Config.Service
    const catalogs = yield* PacerModels.Service

    const projectOf = Effect.fnUntraced(function* (parent: SessionSchema.Info) {
      const project = MemoryClient.project(yield* config.entries(), parent.projectID)
      if (project === undefined)
        return yield* new ToolFailure({
          message: "This chat is in no project, so it has no memory; the setting memory.project can name one.",
        })
      return project
    })

    return Service.of({
      assign: Effect.fn("MemoryTask.assign")(function* (parent, taskID) {
        const memory = (yield* catalogs.get())?.pacer?.memory
        if (!memory?.tasks)
          return yield* new ToolFailure({
            message: `There is no task ${taskID}: memory on this server has no tasks, so no subagent was started.`,
          })
        const project = yield* projectOf(parent)
        const task = (yield* client.task(project, taskID).pipe(Effect.mapError(fail))).task
        const place = placeOf(task)
        return { project, task, inside: place, metadata: placed(parent.metadata, place) }
      }),
      activate: Effect.fn("MemoryTask.activate")(function* (assigned, child) {
        yield* client
          .change(assigned.project, assigned.task.id, {
            state: "active",
            by: { role: child.role, chat: child.id, ...assigned.inside },
          })
          .pipe(Effect.mapError(fail))
      }),
      ended: Effect.fn("MemoryTask.ended")(function* (parent, taskID, output) {
        const project = MemoryClient.project(yield* config.entries(), parent.projectID)
        if (project === undefined) return output
        const read = yield* client.task(project, taskID).pipe(Effect.option)
        if (read._tag === "None" || read.value.task.state === "active") return output
        return `${output}\n${MemoryText.ended(read.value.task)}`
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [MemoryClient.node, Config.node, PacerModels.node],
})

/** Not as the failure's cause, which would make it an unknown error rather than the tool's. */
function fail(error: { readonly message: string }) {
  return new ToolFailure({ message: error.message })
}
