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

/** A row of the recall log: one search or start, what followed it in the chat, and its labels. */
export const Recall = Schema.Struct({
  id: Schema.String,
  kind: Schema.NullOr(Schema.Literals(["search", "start", "prompt", "summary"])),
  query: Schema.String,
  entries: Schema.Array(Schema.String),
  meaning: Schema.NullOr(Schema.Boolean),
  at: Schema.Number,
  after: Schema.NullOr(
    Schema.Struct({
      step: Schema.NullOr(Schema.String),
      acted: Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String, how: Schema.String }))),
      person: Schema.NullOr(Schema.String),
      step_at: Schema.NullOr(Schema.Number),
      person_at: Schema.NullOr(Schema.Number),
    }),
  ),
  labels: Schema.Array(Schema.Unknown),
})
export interface Recall extends Schema.Schema.Type<typeof Recall> {}
const RecallAnswer = Schema.Struct({ recall: Recall })

const EntryAnswer = Schema.Struct({ entry: Entry })
// An older server answers no `near`.
const Written = Schema.Struct({
  entry: Entry,
  existing: Schema.optional(Schema.Boolean),
  near: Schema.optional(Schema.Array(Near)),
})
const Found = Schema.Struct({ recall: Schema.String, entries: Schema.Array(Entry), meaning: Schema.Boolean })
export interface Found extends Schema.Schema.Type<typeof Found> {}
// An older server answers `start`'s task without `changes`, and its subtask as a task alone.
const StartedTask = Schema.Struct({
  task: Task,
  changes: Schema.optional(Schema.Array(Change)),
  subtasks: Schema.Array(Task),
  entries: Schema.Array(Entry),
})
const StartedAnswer = Schema.Struct({
  /** Null when `limit` was 0: no search ran, and nothing is read of `meaning`. */
  recall: Schema.NullOr(Schema.String),
  entries: Schema.Array(Entry),
  meaning: Schema.optional(Schema.Boolean),
  counts: Schema.Struct({ global: Schema.Number, role: Schema.Number, task: Schema.Number }),
  // A server without tasks may answer neither.
  task: maybe(StartedTask),
  subtask: maybe(Schema.Union([StartedTask, Task])),
})
type StartedAnswer = typeof StartedAnswer.Type
/** `prompt`'s answer: the entries that match a prompt closely, at most 2, or none. */
const Prompted = Schema.Struct({
  recall: Schema.NullOr(Schema.String),
  entries: Schema.Array(Entry),
  meaning: Schema.Boolean,
})
export interface Prompted extends Schema.Schema.Type<typeof Prompted> {}
/** `start`'s answer, its task and subtask as reading them answers (`changes` empty from an older server). */
export interface Started extends Omit<StartedAnswer, "task" | "subtask"> {
  readonly task?: TaskRead | null
  readonly subtask?: TaskRead | null
}

function started(answer: StartedAnswer): Started {
  const read = (found: typeof StartedTask.Type): TaskRead => ({ ...found, changes: found.changes ?? [] })
  const subtask = answer.subtask
  return {
    ...answer,
    task: answer.task ? read(answer.task) : answer.task,
    subtask:
      subtask && "id" in subtask ? { task: subtask, changes: [], subtasks: [], entries: [] } : subtask && read(subtask),
  }
}

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
  /** 0 on a server with `prompt`: no search runs, and the answer has no entries and no recall. */
  readonly limit: number
  /**
   * After a compaction, on a server with `summary`: the parts of its summary (1 to 16, each 1 to 2,000 characters),
   * whose close entries the answer then holds; `limit` is 0.
   */
  readonly summary?: ReadonlyArray<string>
  /** With `summary`: the entries the chat still has in view, which are not answered again; at most 100. */
  readonly exclude?: ReadonlyArray<string>
  /** The chat's task (one without a parent) and its subtask, whose parts the answer then holds. */
  readonly task?: string
  readonly subtask?: string
  readonly by: By
}

export interface PromptInput {
  /** The person's prompt, cut to its first 2,000 characters. */
  readonly prompt: string
  readonly scopes: Scopes
  /** The entries the chat has in view, which are not answered again; at most 100. */
  readonly exclude: ReadonlyArray<string>
  readonly by: By
}

/** What followed a search in the chat: the step after it, the person's next message, or both. */
export interface AfterInput {
  readonly step?: string
  /** The entries the search returned that the step replaced or deleted. */
  readonly acted?: ReadonlyArray<{ readonly id: string; readonly how: "superseded" | "forgotten" }>
  readonly person?: string
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

/** No such row in this project's recall log, or one already gone. */
export class MissingRecall extends Schema.TaggedError<MissingRecall>()("MemoryClient.MissingRecall", {
  id: Schema.String,
}) {
  override get message() {
    return `There is no recall ${this.id} in this project's memory.`
  }
}

/**
 * CPP keeps this chat's project's memory from the asking key: memory is off for the project (`project_memory_off`), or
 * the key may not use it (`project_forbidden`) (workspace spec `docs/specs/cpp-projects.md`, "Memory follows the
 * project"). `project` is the project's name and `moved` whether the chat was moved into it, both unknown from a server
 * before moves. The message is what every memory tool answers while the chat still has the tools.
 */
export class Closed extends Schema.TaggedError<Closed>()("MemoryClient.Closed", {
  type: Schema.Literals(["project_memory_off", "project_forbidden"]),
  project: Schema.optional(Schema.String),
  moved: Schema.optional(Schema.Boolean),
}) {
  override get message() {
    const where = this.moved
      ? "the project this chat was moved to on CLIProxyPacer's Projects page"
      : "this chat's project on CLIProxyPacer"
    const project = this.project === undefined ? where : `${JSON.stringify(this.project)}, ${where}`
    const closed =
      this.type === "project_memory_off"
        ? `Memory is off for ${project}`
        : `This key may not use the memory of ${project}`
    return `${closed}: the memory tools stop working now and leave this chat at its next cold moment. Go on without them.`
  }
}

export type Error = Unavailable | Refused | Missing | MissingTask | MissingRecall | Closed

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
  /** The entries that match a person's prompt closely, or none. */
  readonly prompt: (
    project: string,
    input: PromptInput,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<Prompted, Error>
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
  /** Adds what followed to a search's row of the recall log; each part is kept once, the first that comes. */
  readonly after: (
    project: string,
    id: string,
    input: AfterInput,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<Recall, Error>
  /** Reads one row of the recall log. */
  readonly recall: (project: string, id: string) => Effect.Effect<Recall, Error>
  /** The same client, its requests carrying `headers`: the chat and its project as CPP knows them (`PacerHeaders.chat`). */
  readonly withHeaders: (headers: Readonly<Record<string, string>>) => Interface
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryClient") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const base = (project: string) => `/pacer/v1/memory/${encodeURIComponent(project)}`
    const entry = (project: string, id: string) => `${base(project)}/entries/${encodeURIComponent(id)}`
    const task = (project: string, id: string) => `${base(project)}/tasks/${encodeURIComponent(id)}`
    const recall = (project: string, id: string) => `${base(project)}/recalls/${encodeURIComponent(id)}`

    const make = (headers: Readonly<Record<string, string>>): Interface => ({
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
            { headers },
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
        http.get(entry(project, id), EntryAnswer, { headers }).pipe(
          Effect.map((answer) => answer.body.entry),
          Effect.mapError(failure(id)),
        ),
      forget: (project, id, input) =>
        http.post(`${entry(project, id)}/forget`, input, EntryAnswer, { headers }).pipe(
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
            { headers },
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
            StartedAnswer,
            { ...options, headers },
          )
          .pipe(
            Effect.map((answer) => started(answer.body)),
            Effect.mapError(failure()),
          ),
      prompt: (project, input, options) =>
        http.post(`${base(project)}/prompt`, input, Prompted, { ...options, headers }).pipe(
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
            { headers },
          )
          .pipe(
            Effect.map((answer) => ({ task: answer.body.task, existing: answer.body.existing === true })),
            Effect.mapError(failure(input.parent, "task")),
          ),
      tasks: (project) =>
        http.get(`${base(project)}/tasks`, TaskList, { headers }).pipe(
          Effect.map((answer) => answer.body),
          Effect.mapError(failure()),
        ),
      task: (project, id) =>
        http.get(task(project, id), TaskRead, { headers }).pipe(
          Effect.map((answer) => answer.body),
          Effect.mapError(failure(id, "task")),
        ),
      change: (project, id, input) =>
        http.post(`${task(project, id)}/state`, input, TaskAnswer, { headers }).pipe(
          Effect.map((answer) => answer.body.task),
          Effect.mapError(failure(id, "task")),
        ),
      after: (project, id, input, options) =>
        http.post(`${recall(project, id)}/after`, input, RecallAnswer, { ...options, headers }).pipe(
          Effect.map((answer) => answer.body.recall),
          Effect.mapError(failure(id, "recall")),
        ),
      recall: (project, id) =>
        http.get(recall(project, id), RecallAnswer, { headers }).pipe(
          Effect.map((answer) => answer.body.recall),
          Effect.mapError(failure(id, "recall")),
        ),
      withHeaders: make,
    })

    return Service.of(make({}))
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
 * entry is that entry missing; on any other route, or without the server's type, the proxy has no memory. A project's
 * memory kept from the key is {@link Closed}.
 */
function failure(id?: string, thing: "entry" | "task" | "recall" = "entry") {
  return (error: PacerHttp.Error): Error => {
    if (
      (error._tag === "PacerHttp.NoPacer" && error.type === "project_memory_off") ||
      (error._tag === "PacerHttp.Refused" && error.type === "project_forbidden")
    )
      return new Closed({
        type: error.type,
        ...(error.project === undefined ? {} : { project: error.project.name }),
        ...(error.moved === undefined ? {} : { moved: error.moved }),
      })
    if (error._tag === "PacerHttp.NotFound" && id !== undefined)
      return thing === "task"
        ? new MissingTask({ id })
        : thing === "recall"
          ? new MissingRecall({ id })
          : new Missing({ id })
    if (error._tag === "PacerHttp.Unexpected" && (error.status === 400 || error.status === 409))
      return new Refused({ reason: error.reason })
    return new Unavailable({ reason: error.message })
  }
}
