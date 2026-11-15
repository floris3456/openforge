export * as MemoryClient from "./client.js"

import { Context, type Duration, Effect, Layer, Schema } from "effect"
import { ConfigMemory } from "@opencode/schema/config/memory"
import { ProjectID } from "@opencode/schema/project-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Config } from "../config.js"
import { PacerHttp } from "../pacer/http.js"

// What a harness asks of memory under `/pacer/v1/memory/{project}` (the workspace's `docs/reference/memory-api.md` and
// `docs/reference/cpp-tools-api.md`, "A harness's texts"), for one project at a time: the start block, the entries
// near a prompt, the task check, a subagent's task, what followed a search, and memory's texts. CPP holds every rule
// and text; who asks is in the headers (`PacerHeaders.chat` with the agent), never in a body the model writes.

const maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

/** What openforge reads of an entry an answer names: its id. */
const Named = Schema.Struct({ id: Schema.String })

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

/** The chat's place as CPP keeps it (workspace reference `docs/reference/cpp-tools-api.md`, "The chat's place"). */
const Place = Schema.NullOr(Schema.Struct({ task: Schema.String, subtask: maybe(Schema.String) }))
export type Place = { readonly task: string; readonly subtask: string | null } | null
const placeOf = (place: typeof Place.Type | undefined): Place | undefined =>
  place === undefined ? undefined : place && { task: place.task, subtask: place.subtask ?? null }

const StartedPart = Schema.Struct({ entries: Schema.optional(Schema.Array(Named)) })
const StartedAnswer = Schema.Struct({
  /** The whole start block, as the model reads it. */
  text: Schema.String,
  /** Null when `limit` was 0: no search ran, and nothing is read of `meaning`. */
  recall: Schema.NullOr(Schema.String),
  entries: Schema.Array(Named),
  /** With `summary`: the entries close to it that it already says, left out. */
  said: Schema.optional(Schema.Array(Schema.String)),
  meaning: Schema.optional(Schema.Boolean),
  task: maybe(StartedPart),
  subtask: maybe(StartedPart),
  place: Schema.optional(Place),
})
/** `start`'s answer: the block's text, its search, and the chat's place. */
export interface Started {
  readonly text: string
  readonly recall: string | null
  /** The ids of the entries the block holds. */
  readonly entries: ReadonlyArray<string>
  readonly said?: ReadonlyArray<string>
  readonly meaning?: boolean
  /** The ids of the entries its task part may show. */
  readonly shown: ReadonlyArray<string>
  readonly place?: Place
}
/** `prompt`'s answer: the entries that match a prompt closely, and the message that holds them, or null for none. */
const PromptedAnswer = Schema.Struct({
  recall: Schema.NullOr(Schema.String),
  entries: Schema.Array(Named),
  text: maybe(Schema.String),
})
export interface Prompted {
  readonly recall: string | null
  readonly entries: ReadonlyArray<string>
  readonly text: string | null
}
const ChatAnswer = Schema.Struct({ place: Schema.optional(Place), check: maybe(Schema.String) })
const Failure = Schema.Struct({ code: Schema.String, message: maybe(Schema.String) })
const StepAnswer = Schema.Struct({
  text: maybe(Schema.String),
  error: maybe(Failure),
  place: Schema.optional(Place),
})
/** A task route's answer, as a call's: `error` a refusal whose `text` the model reads. */
export interface Step {
  readonly text: string
  readonly error?: { readonly code: string; readonly message: string }
  readonly place?: Place
}
const EndedAnswer = Schema.Struct({ text: maybe(Schema.String) })
const TextsAnswer = Schema.Struct({ unavailable: Schema.String, refused: Schema.String })
/** memory's texts for when CPP cannot be reached or a rule of openforge's hooks says no. */
export interface Texts extends Schema.Schema.Type<typeof TextsAnswer> {}

/** Who calls: the agent running the call (its role) and the chat. The model never sets it. */
export interface By {
  readonly role: string
  readonly chat: string
  /** The task the chat is inside, and its subtask: labels openforge sets from the chat's metadata. */
  readonly task?: string
  readonly subtask?: string
}

export interface StartInput {
  readonly prompt: string
  /** 0 on a server with `prompt`: no search runs, and the answer has no entries and no recall. */
  readonly limit: number
  /**
   * After a compaction, on a server with `summary`: the parts of its summary (1 to 16, each 1 to 2,000 characters),
   * whose close entries the answer then holds; `limit` is 0.
   */
  readonly summary?: ReadonlyArray<string>
  /** With `summary`: the entries the chat still has in view, which are not answered again; at most 100. */
  readonly exclude?: ReadonlyArray<string>
  /** Which of the tools the chat's agent may use: the block then speaks of them. */
  readonly tools: { readonly recall: boolean; readonly remember: boolean; readonly task: boolean }
}

export interface PromptInput {
  /** The person's prompt, cut to its first 2,000 characters. */
  readonly prompt: string
  /** The entries the chat has in view, which are not answered again; at most 100. */
  readonly exclude: ReadonlyArray<string>
}

/** What followed a search in the chat: the step after it, the person's next message, or both. */
export interface AfterInput {
  readonly step?: string
  /** The entries the search returned that the step replaced or deleted. */
  readonly acted?: ReadonlyArray<{ readonly id: string; readonly how: "superseded" | "forgotten" }>
  readonly person?: string
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
 * before moves.
 */
export class Closed extends Schema.TaggedError<Closed>()("MemoryClient.Closed", {
  type: Schema.Literals(["project_memory_off", "project_forbidden"]),
  project: Schema.optional(Schema.String),
  moved: Schema.optional(Schema.Boolean),
}) {
  override get message() {
    const project = this.project === undefined ? "this chat's project" : JSON.stringify(this.project)
    return this.type === "project_memory_off"
      ? `Memory is off for ${project}${this.moved ? ", the project this chat was moved to" : ""}`
      : `This key may not use the memory of ${project}${this.moved ? ", the project this chat was moved to" : ""}`
  }
}

export type Error = Unavailable | Refused | MissingTask | MissingRecall | Closed

export interface Interface {
  /** The chat's start block, in one call; `tools` names what it may speak of. */
  readonly start: (
    project: string,
    input: StartInput,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<Started, Error>
  /** The entries that match a person's prompt closely, and their message, or none. */
  readonly prompt: (
    project: string,
    input: PromptInput,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<Prompted, Error>
  /** The chat's place, and the task check's line while its task or subtask is active, else null. */
  readonly chat: (
    project: string,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<{ readonly place?: Place; readonly check: string | null }, Error>
  /** With the lead's headers, before a subagent is started on task `id`: the child's place to be, or a refusal. */
  readonly assign: (project: string, id: string) => Effect.Effect<Step, Error>
  /** With the child's headers, before its first step: sets task `id` active in its name. */
  readonly begin: (project: string, id: string) => Effect.Effect<Step, Error>
  /** What the subagent's answer gets after it when task `id` is no longer active, else null. */
  readonly ended: (project: string, id: string) => Effect.Effect<string | null, Error>
  /** Adds what followed to a search's row of the recall log; each part is kept once, the first that comes. */
  readonly after: (
    project: string,
    id: string,
    input: AfterInput,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<Recall, Error>
  /** Reads one row of the recall log. */
  readonly recall: (project: string, id: string) => Effect.Effect<Recall, Error>
  /** memory's texts for when the server cannot be reached; without a project. */
  readonly texts: (options?: { readonly timeout?: Duration.Input }) => Effect.Effect<Texts, Error>
  /** The same client, its requests carrying `headers`: the chat and its project as CPP knows them (`PacerHeaders.chat`). */
  readonly withHeaders: (headers: Readonly<Record<string, string>>) => Interface
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryClient") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const base = (project: string) => `/pacer/v1/memory/${encodeURIComponent(project)}`
    const task = (project: string, id: string) => `${base(project)}/tasks/${encodeURIComponent(id)}`
    const recall = (project: string, id: string) => `${base(project)}/recalls/${encodeURIComponent(id)}`

    const make = (headers: Readonly<Record<string, string>>): Interface => ({
      start: (project, input, options) =>
        http.post(`${base(project)}/start`, input, StartedAnswer, { ...options, headers }).pipe(
          Effect.map((answer) => ({
            text: answer.body.text,
            recall: answer.body.recall,
            entries: answer.body.entries.map((item) => item.id),
            ...(answer.body.said === undefined ? {} : { said: answer.body.said }),
            ...(answer.body.meaning === undefined ? {} : { meaning: answer.body.meaning }),
            shown: [...(answer.body.task?.entries ?? []), ...(answer.body.subtask?.entries ?? [])].map(
              (item) => item.id,
            ),
            ...(answer.body.place === undefined ? {} : { place: placeOf(answer.body.place) }),
          })),
          Effect.mapError(failure()),
        ),
      prompt: (project, input, options) =>
        http.post(`${base(project)}/prompt`, input, PromptedAnswer, { ...options, headers }).pipe(
          Effect.map((answer) => ({
            recall: answer.body.recall,
            entries: answer.body.entries.map((item) => item.id),
            text: answer.body.text ?? null,
          })),
          Effect.mapError(failure()),
        ),
      chat: (project, options) =>
        http.get(`${base(project)}/chat`, ChatAnswer, { ...options, headers }).pipe(
          Effect.map((answer) => ({
            ...(answer.body.place === undefined ? {} : { place: placeOf(answer.body.place) }),
            check: answer.body.check ?? null,
          })),
          Effect.mapError(failure()),
        ),
      assign: (project, id) =>
        http.post(`${task(project, id)}/assign`, {}, StepAnswer, { headers }).pipe(
          Effect.map((answer) => step(answer.body)),
          Effect.mapError(failure(id, "task")),
        ),
      begin: (project, id) =>
        http.post(`${task(project, id)}/start`, {}, StepAnswer, { headers }).pipe(
          Effect.map((answer) => step(answer.body)),
          Effect.mapError(failure(id, "task")),
        ),
      ended: (project, id) =>
        http.get(`${task(project, id)}/ended`, EndedAnswer, { headers }).pipe(
          Effect.map((answer) => answer.body.text ?? null),
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
      texts: (options) =>
        http.get("/pacer/v1/memory/texts", TextsAnswer, { ...options, headers }).pipe(
          Effect.map((answer) => answer.body),
          Effect.mapError(failure()),
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
function failure(id?: string, thing: "task" | "recall" = "task") {
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
      return thing === "task" ? new MissingTask({ id }) : new MissingRecall({ id })
    if (error._tag === "PacerHttp.Unexpected" && (error.status === 400 || error.status === 409))
      return new Refused({ reason: error.reason })
    return new Unavailable({ reason: error.message })
  }
}

function step(answer: typeof StepAnswer.Type): Step {
  return {
    text: answer.text ?? "",
    ...(answer.error ? { error: { code: answer.error.code, message: answer.error.message ?? "" } } : {}),
    ...(answer.place === undefined ? {} : { place: placeOf(answer.place) }),
  }
}
