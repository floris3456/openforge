export * as MemoryClient from "./client.js"

import { Context, type Duration, Effect, Layer, Schema } from "effect"
import { ConfigMemory } from "@opencode/schema/config/memory"
import { ProjectID } from "@opencode/schema/project-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Config } from "../config.js"
import { PacerHttp } from "../pacer/http.js"

// The memory API's routes under `/pacer/v1/memory/{project}` (the workspace's `docs/reference/memory-api.md`), for one
// project at a time. Who may write, replace or delete what is the caller's to check: the server cannot tell a lead
// from a child, nor one role from another.

export const Kind = Schema.Literals(["words", "unverified", "verified"])
export type Kind = typeof Kind.Type

const maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

export const Entry = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  /** Null once deleted. */
  text: Schema.NullOr(Schema.String),
  basis: Schema.NullOr(Schema.String),
  scope: Schema.Literals(["global", "role", "task"]),
  role: maybe(Schema.String),
  task: maybe(Schema.String),
  subtask: maybe(Schema.String),
  by: Schema.Struct({ person: Schema.String, role: Schema.String, chat: Schema.String }),
  /** Unix milliseconds. */
  at: Schema.Number,
  supersedes: maybe(Schema.String),
  superseded_by: maybe(Schema.String),
  deleted: maybe(Schema.Struct({ reason: maybe(Schema.String) })),
})
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

/** An entry near the one a write wrote; `score` is the cosine of their vectors. */
export const Near = Schema.Struct({ ...Entry.fields, score: Schema.Number })
export interface Near extends Schema.Schema.Type<typeof Near> {}

export const State = Schema.Literals(["todo", "active", "blocked", "review", "done"])
export type State = typeof State.Type

const Who = Schema.Struct({ person: Schema.String, role: Schema.String, chat: Schema.String })

/** A task or, with a `parent`, a subtask (the memory API's section "Tasks"). */
export const Task = Schema.Struct({
  id: Schema.String,
  parent: maybe(Schema.String),
  title: Schema.String,
  description: Schema.String,
  state: State,
  note: maybe(Schema.String),
  by: Who,
  /** Who last set it active. */
  worker: maybe(Who),
  /** Unix milliseconds. */
  at: Schema.Number,
  changed: Schema.Number,
})
export interface Task extends Schema.Schema.Type<typeof Task> {}

export const Change = Schema.Struct({ state: State, note: maybe(Schema.String), by: Who, at: Schema.Number })
export interface Change extends Schema.Schema.Type<typeof Change> {}

/** One task as `GET …/tasks/{id}` answers it: its changes newest first, its subtasks oldest first, its entries. */
const TaskRead = Schema.Struct({
  task: Task,
  changes: Schema.Array(Change),
  subtasks: Schema.Array(Task),
  entries: Schema.Array(Entry),
})
export interface TaskRead extends Schema.Schema.Type<typeof TaskRead> {}
const TaskAnswer = Schema.Struct({ task: Task, existing: Schema.optional(Schema.Boolean) })
const TaskList = Schema.Struct({ tasks: Schema.Array(Task), more: Schema.Boolean })
export interface TaskList extends Schema.Schema.Type<typeof TaskList> {}

const EntryAnswer = Schema.Struct({ entry: Entry })
// An older server answers no `near`.
const Written = Schema.Struct({
  entry: Entry,
  existing: Schema.optional(Schema.Boolean),
  near: Schema.optional(Schema.Array(Near)),
})
const Found = Schema.Struct({ recall: Schema.String, entries: Schema.Array(Entry), meaning: Schema.Boolean })
export interface Found extends Schema.Schema.Type<typeof Found> {}
const Started = Schema.Struct({
  recall: Schema.String,
  entries: Schema.Array(Entry),
  meaning: Schema.Boolean,
  counts: Schema.Struct({ global: Schema.Number, role: Schema.Number, task: Schema.Number }),
  // A server without tasks may answer neither.
  task: Schema.optional(
    Schema.NullOr(Schema.Struct({ task: Task, subtasks: Schema.Array(Task), entries: Schema.Array(Entry) })),
  ),
  subtask: maybe(Task),
})
export interface Started extends Schema.Schema.Type<typeof Started> {}

/** Who calls: the agent running the call (its role) and the chat. The model never sets it. */
export interface By {
  readonly role: string
  readonly chat: string
  /** The task the chat is inside, and its subtask: labels openforge sets from the chat's metadata. */
  readonly task?: string
  readonly subtask?: string
}

/**
 * Which live entries a search looks in: a union of the global ones, those of the listed roles and those of the listed
 * tasks (each with its subtasks), or all.
 */
export type Scopes =
  | {
      readonly global?: boolean
      readonly roles?: ReadonlyArray<string>
      readonly tasks?: ReadonlyArray<string>
    }
  | "all"

export interface WriteInput {
  readonly kind: Kind
  readonly text: string
  readonly basis?: string
  readonly scope: "global" | "role" | "task"
  readonly supersedes?: string
  /** With `supersedes`: the replacement belongs where `scope` says, not where the replaced entry was. */
  readonly move?: boolean
  readonly by: By
}

export interface SearchInput {
  readonly query: string
  readonly scopes: Scopes
  readonly kinds?: ReadonlyArray<Kind>
  readonly limit: number
  readonly by: By
}

export interface StartInput {
  readonly prompt: string
  readonly scopes: Scopes
  readonly limit: number
  /** The chat's task (one without a parent) and its subtask, whose parts the answer then holds. */
  readonly task?: string
  readonly subtask?: string
  readonly by: By
}

export interface MakeInput {
  readonly title: string
  readonly description?: string
  /** The task this is a subtask of. */
  readonly parent?: string
  readonly by: By
}

export interface ChangeInput {
  readonly state: State
  readonly note?: string
  readonly by: By
}

/** Memory cannot be used now: not set up, unreachable, refused, a proxy without memory, a timeout, busy. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("MemoryClient.Unavailable", {
  reason: Schema.String,
}) {
  override get message() {
    return "Memory is unavailable right now, so the work goes on without it."
  }
}

/** The server refused the request (400, 409); its message is written for a model. */
export class Refused extends Schema.TaggedError<Refused>()("MemoryClient.Refused", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

/** No such entry in this project's memory. */
export class Missing extends Schema.TaggedError<Missing>()("MemoryClient.Missing", { id: Schema.String }) {
  override get message() {
    return `There is no entry ${this.id} in this project's memory.`
  }
}

/** No such task in this project's memory. */
export class MissingTask extends Schema.TaggedError<MissingTask>()("MemoryClient.MissingTask", { id: Schema.String }) {
  override get message() {
    return `There is no task ${this.id} in this project's memory.`
  }
}

export type Error = Unavailable | Refused | Missing | MissingTask

export interface Interface {
  /**
   * Writes one entry, or replaces the one `supersedes` names; `existing` when a live exact copy answered instead.
   * `near`: the at most 3 live entries of the project nearest to the one written, best first; empty when nothing was
   * written or the server made no vector for it.
   */
  readonly write: (
    project: string,
    input: WriteInput,
  ) => Effect.Effect<{ readonly entry: Entry; readonly existing: boolean; readonly near: ReadonlyArray<Near> }, Error>
  /** Reads one entry of the project, live or not. */
  readonly read: (project: string, id: string) => Effect.Effect<Entry, Error>
  /** Deletes one entry's text for good. */
  readonly forget: (
    project: string,
    id: string,
    input: { readonly reason: string; readonly by: By },
  ) => Effect.Effect<Entry, Error>
  readonly search: (project: string, input: SearchInput) => Effect.Effect<Found, Error>
  /** The parts of a chat's start block, in one call. */
  readonly start: (
    project: string,
    input: StartInput,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<Started, Error>
  /** Makes a task, or a subtask of `parent`; `existing` when a task that is not done had that title and parent. */
  readonly make: (
    project: string,
    input: MakeInput,
  ) => Effect.Effect<{ readonly task: Task; readonly existing: boolean }, Error>
  /** The open tasks and subtasks, newest first, at most 200; `more` when there are others. */
  readonly tasks: (project: string) => Effect.Effect<TaskList, Error>
  readonly task: (project: string, id: string) => Effect.Effect<TaskRead, Error>
  /** Sets a task's state and note; `active` makes the caller its worker. */
  readonly change: (project: string, id: string, input: ChangeInput) => Effect.Effect<Task, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryClient") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const base = (project: string) => `/pacer/v1/memory/${encodeURIComponent(project)}`
    const entry = (project: string, id: string) => `${base(project)}/entries/${encodeURIComponent(id)}`
    const task = (project: string, id: string) => `${base(project)}/tasks/${encodeURIComponent(id)}`

    return Service.of({
      write: (project, input) =>
        http
          .post(
            `${base(project)}/entries`,
            {
              kind: input.kind,
              text: input.text,
              ...(input.basis === undefined ? {} : { basis: input.basis }),
              scope: input.scope,
              by: input.by,
              supersedes: input.supersedes ?? null,
              ...(input.move === undefined ? {} : { move: input.move }),
            },
            Written,
          )
          .pipe(
            Effect.map((answer) => ({
              entry: answer.body.entry,
              existing: answer.body.existing === true,
              near: answer.body.near ?? [],
            })),
            Effect.mapError(failure(input.supersedes)),
          ),
      read: (project, id) =>
        http.get(entry(project, id), EntryAnswer).pipe(
          Effect.map((answer) => answer.body.entry),
          Effect.mapError(failure(id)),
        ),
      forget: (project, id, input) =>
        http.post(`${entry(project, id)}/forget`, input, EntryAnswer).pipe(
          Effect.map((answer) => answer.body.entry),
          Effect.mapError(failure(id)),
        ),
      search: (project, input) =>
        http
          .post(
            `${base(project)}/search`,
            {
              query: input.query,
              scopes: input.scopes,
              ...(input.kinds ? { kinds: input.kinds } : {}),
              limit: input.limit,
              by: input.by,
            },
            Found,
          )
          .pipe(
            Effect.map((answer) => answer.body),
            Effect.mapError(failure()),
          ),
      start: (project, input, options) =>
        http
          .post(
            `${base(project)}/start`,
            { ...input, task: input.task ?? null, subtask: input.subtask ?? null },
            Started,
            options,
          )
          .pipe(
            Effect.map((answer) => answer.body),
            Effect.mapError(failure()),
          ),
      make: (project, input) =>
        http
          .post(
            `${base(project)}/tasks`,
            {
              title: input.title,
              ...(input.description === undefined ? {} : { description: input.description }),
              parent: input.parent ?? null,
              by: input.by,
            },
            TaskAnswer,
          )
          .pipe(
            Effect.map((answer) => ({ task: answer.body.task, existing: answer.body.existing === true })),
            Effect.mapError(failure(input.parent, "task")),
          ),
      tasks: (project) =>
        http.get(`${base(project)}/tasks`, TaskList).pipe(
          Effect.map((answer) => answer.body),
          Effect.mapError(failure()),
        ),
      task: (project, id) =>
        http.get(task(project, id), TaskRead).pipe(
          Effect.map((answer) => answer.body),
          Effect.mapError(failure(id, "task")),
        ),
      change: (project, id, input) =>
        http.post(`${task(project, id)}/state`, input, TaskAnswer).pipe(
          Effect.map((answer) => answer.body.task),
          Effect.mapError(failure(id, "task")),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [PacerHttp.node] })

/**
 * The project a chat's memory belongs to: `memory.project` from the directory's config, else the chat's own project.
 * Undefined for a chat outside any project, which has no memory.
 */
export function project(entries: Parameters<typeof Config.latest>[0], projectID: string) {
  const configured = Config.latest(entries, "memory")?.project
  if (configured !== undefined) return configured
  if (projectID === ProjectID.global) return undefined
  return Schema.is(ConfigMemory.Project)(projectID) ? projectID : undefined
}

/**
 * How an answer that is not the entry reads to an agent. A 404 of the server's own (`not_found`) on a route naming an
 * entry is that entry missing; on any other route, or without the server's type, the proxy has no memory.
 */
function failure(id?: string, thing: "entry" | "task" = "entry") {
  return (error: PacerHttp.Error): Error => {
    if (error._tag === "PacerHttp.NotFound" && id !== undefined)
      return thing === "task" ? new MissingTask({ id }) : new Missing({ id })
    if (error._tag === "PacerHttp.Unexpected" && (error.status === 400 || error.status === 409))
      return new Refused({ reason: error.reason })
    return new Unavailable({ reason: error.message })
  }
}
