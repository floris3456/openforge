export * as MemoryTask from "./task.js"

import { ToolFailure } from "@opencode/ai/effect"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Agent } from "../agent.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import type { SessionSchema } from "../session/schema.js"
import { MemoryClient } from "./client.js"

// Where a chat's task is kept for openforge's own hooks (the workspace's spec `docs/specs/memory.md`, section 5): the
// session's metadata `memory: { task, subtask? }`, `task` always the task that has no parent. CPP keeps the chat's
// place and says it after every call that can change it (workspace reference `docs/reference/cpp-tools-api.md`, "The
// chat's place"); openforge copies it here and never sets it otherwise. A child inherits its parent's metadata when it
// is made, inside the task its lead started it on.

/** The task a chat is inside, and the subtask of it. */
export const Inside = Schema.Struct({ task: Schema.String, subtask: Schema.optional(Schema.String) })
export interface Inside extends Schema.Schema.Type<typeof Inside> {}
const decodeInside = Schema.decodeUnknownOption(Inside)

/** The task the session's metadata says the chat is inside, if any. */
export function inside(metadata: SessionSchema.Metadata | undefined): Inside | undefined {
  const found = decodeInside(metadata?.memory)
  return found._tag === "Some" ? found.value : undefined
}

/** CPP's place as the session's metadata keeps it. */
export function fromPlace(
  place: { readonly task: string; readonly subtask: string | null } | null,
): Inside | undefined {
  if (place === null) return undefined
  return place.subtask === null ? { task: place.task } : { task: place.task, subtask: place.subtask }
}

/** Whether the metadata already says `place`. */
export function at(metadata: SessionSchema.Metadata | undefined, place: Inside | undefined) {
  const held = inside(metadata)
  return held?.task === place?.task && held?.subtask === place?.subtask
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

/** A new child's task, asked before the child is made. */
export interface Assigned {
  /** The chat the child is made under. */
  readonly parent: SessionSchema.ID
  readonly project: string
  readonly task: string
  /** The child's metadata: the parent's, inside the task. */
  readonly metadata: SessionSchema.Metadata
}

/** What the subagent tool asks of tasks (`taskID`); the rest of tasks is CPP's task tool's. */
export interface Interface {
  /** Asks CPP whether the lead may start a child on the task, and where the child will be; refused with CPP's text. */
  readonly assign: (parent: SessionSchema.Info, taskID: string) => Effect.Effect<Assigned, ToolFailure>
  /** Sets the task active in the child's name, before its first step; the child's metadata follows CPP's place. */
  readonly activate: (
    assigned: Assigned,
    child: SessionSchema.Info,
    role: string,
  ) => Effect.Effect<SessionSchema.Metadata | undefined, ToolFailure>
  /** The child's answer with CPP's line after it, when the task is no longer active. */
  readonly ended: (parent: SessionSchema.Info, taskID: string, output: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryTask") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* MemoryClient.Service
    const projects = yield* PacerProject.Service
    const catalogs = yield* PacerModels.Service
    const agents = yield* Agent.Service
    /** The role a chat runs as: its agent, or the default one when it names none. */
    const roleOf = (session: SessionSchema.Info) =>
      agents.select(session.agent).pipe(Effect.map((selected) => String(selected.id)))

    const projectOf = Effect.fnUntraced(function* (parent: SessionSchema.Info) {
      const project = (yield* projects.chat(parent.projectID)).project
      if (project === undefined)
        return yield* new ToolFailure({
          message: "This chat is in no project, so it has no memory; the setting memory.project can name one.",
        })
      return project
    })
    /** The client of `project`, its calls in the name of `chat` and, for a subagent, of its parent. */
    const named = (
      project: string,
      chat: { readonly id: SessionSchema.ID; readonly parentID?: SessionSchema.ID },
      agent?: string,
    ) =>
      client.withHeaders(
        PacerHeaders.chat({
          sessionID: chat.id,
          parentID: chat.parentID,
          project: projects.headers(project),
          ...(agent === undefined ? {} : { agent }),
        }),
      )

    return Service.of({
      assign: Effect.fn("MemoryTask.assign")(function* (parent, taskID) {
        if ((yield* catalogs.get())?.pacer?.memory?.tools !== true)
          return yield* new ToolFailure({
            message: `There is no task ${taskID}: this server serves no memory, so no subagent was started.`,
          })
        const project = yield* projectOf(parent)
        const answer = yield* named(project, parent, yield* roleOf(parent))
          .assign(project, taskID)
          .pipe(Effect.mapError(fail))
        if (answer.error) return yield* new ToolFailure({ message: answer.text || answer.error.message })
        const place = answer.place === undefined ? { task: taskID } : fromPlace(answer.place)
        return { parent: parent.id, project, task: taskID, metadata: placed(parent.metadata, place) }
      }),
      activate: Effect.fn("MemoryTask.activate")(function* (assigned, child, role) {
        const answer = yield* named(assigned.project, { id: child.id, parentID: assigned.parent }, role)
          .begin(assigned.project, assigned.task)
          .pipe(Effect.mapError(fail))
        if (answer.error) return yield* new ToolFailure({ message: answer.text || answer.error.message })
        if (answer.place === undefined) return undefined
        const place = fromPlace(answer.place)
        return at(child.metadata, place) ? undefined : placed(child.metadata, place)
      }),
      ended: Effect.fn("MemoryTask.ended")(function* (parent, taskID, output) {
        const project = (yield* projects.chat(parent.projectID)).project
        if (project === undefined) return output
        const text = yield* named(project, parent, yield* roleOf(parent))
          .ended(project, taskID)
          .pipe(Effect.option)
        if (text._tag === "None" || !text.value) return output
        return `${output}\n${text.value}`
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [MemoryClient.node, PacerProject.node, PacerModels.node, Agent.node],
})

/** Not as the failure's cause, which would make it an unknown error rather than the tool's. */
function fail(error: { readonly message: string }) {
  return new ToolFailure({ message: error.message })
}
