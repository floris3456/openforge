export * as SessionContinuity from "./continuity.js"

import { Usage, type AIError, type CompactionCheckpointResponse, type CompactionResponse } from "@opencode/ai/effect"
import {
  LLMClient,
  RequestExecutor,
  type CheckpointRequest,
  type CompactionRequest,
  type EndpointCompactOptions,
  type LLMClientService,
  type LLMClientShape,
  type TriggerCompactOptions,
} from "@opencode/ai/route"
import { Continuity } from "@opencode/schema/continuity"
import { FinishReason } from "@opencode/schema/llm"
import { SessionError } from "@opencode/schema/session-error"
import { Snapshot } from "@opencode/schema/snapshot"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { and, eq, or } from "drizzle-orm"
import { Cause, Clock, Context, Deferred, Effect, Exit, Latch, Layer, Option, Schema, Scope, Stream } from "effect"
import { Bus } from "./bus.js"
import { PendingRequestTable, SessionRestTable } from "./continuity/sql.js"
import { Database } from "./database/database.js"
import { requestExecutor } from "./effect/app-node-platform.js"
import { KV } from "./kv.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"

const PAUSE_TIMEOUT = 120_000
/** Written when a pause completes, so the next start knows its executions rested and adds no restart notice. */
const RESTED = "continuity.rested"

/** A drain resting at the top of its loop: the state a location reload would carry. */
const Boundary = Schema.Struct({
  kind: Schema.Literal("boundary"),
  force: Schema.Boolean,
  continuation: Schema.optional(Schema.Struct({ step: Schema.Number })),
  stepped: Schema.optional(Schema.Boolean),
})

/** A step waiting to call the model again, with the deadline and count its retry policy decided. */
const Retry = Schema.Struct({
  kind: Schema.Literal("retry"),
  step: Schema.Number,
  assistantMessageID: SessionMessage.ID,
  mode: Schema.Literals(["retry", "continue"]),
  attempt: Schema.Number,
  timeouts: Schema.Number,
  at: Schema.Number,
  error: SessionError.Error,
})

/** A step whose reply has streamed, with the provider's finish its Step.Ended still needs once its tools settle. */
const Tools = Schema.Struct({
  kind: Schema.Literal("tools"),
  step: Schema.Number,
  assistantMessageID: SessionMessage.ID,
  snapshot: Schema.optional(Snapshot.ID),
  finish: Schema.Struct({
    finish: FinishReason,
    rawFinish: Schema.optional(Schema.String),
    native: Schema.optional(SessionMessage.Native),
    usage: Schema.optional(Usage),
  }),
})

const Rest = Schema.Union([Boundary, Retry, Tools])
export type Rest = typeof Rest.Type
export type RetryRest = typeof Retry.Type
export type ToolsRest = typeof Tools.Type

const decodeRest = Schema.decodeUnknownOption(Rest)
const encodeRest = Schema.encodeSync(Rest)

/** A tool call that a restart continues: run again from its beginning, or resumed by the tool from `data`. */
export interface Checkpoint {
  readonly messageID: SessionMessage.ID | null
  readonly data: unknown
}

export interface Restored {
  readonly rest?: Rest
  readonly tools: ReadonlyMap<string, Checkpoint>
}

type ToolState = "busy" | "gated" | "waiting" | "done"

interface ToolEntry {
  readonly id: string
  readonly name: string
  readonly messageID: SessionMessage.ID
  /** Whether a wait inside it may outlast the process; false for tools that run other tools. */
  readonly survives: boolean
  /** A call a restart continues; `resume` holds its checkpoint data, if any. */
  readonly rerun?: boolean
  readonly resume?: unknown
  state: ToolState
}

/** One Session's execution as a pause sees it: busy, except while it rests or every tool of its step waits. */
export class Activity {
  resting = 0
  streamed = false
  readonly tools = new Map<string, ToolEntry>()

  constructor(
    readonly sessionID: SessionSchema.ID,
    private readonly changed: () => void,
  ) {}

  get rested() {
    if (this.resting > 0) return true
    if (!this.streamed) return false
    const tools = Array.from(this.tools.values())
    return (
      tools.some((tool) => tool.state === "gated" || tool.state === "waiting") &&
      tools.every((tool) => tool.state !== "busy")
    )
  }

  /** What keeps this execution from resting. */
  busy(): Continuity.Work[] {
    if (this.rested) return []
    const tools = Array.from(this.tools.values()).filter((tool) => tool.state === "busy")
    if (tools.length > 0) return tools.map((tool) => ({ sessionID: this.sessionID, kind: "tool", name: tool.name }))
    return [{ sessionID: this.sessionID, kind: "step", name: this.streamed ? "step" : "reply" }]
  }

  /** A model call starts; tool calls register as they arrive. */
  attempt() {
    this.streamed = false
    this.tools.clear()
    this.changed()
  }

  /** The model's reply has ended; the step now only waits for its tools. */
  endStream() {
    this.streamed = true
    this.changed()
  }

  register(input: {
    readonly id: string
    readonly name: string
    readonly messageID: SessionMessage.ID
    readonly survives: boolean
    readonly rerun?: boolean
    readonly resume?: unknown
  }) {
    const entry: ToolEntry = { ...input, state: "busy" }
    this.tools.set(input.id, entry)
    this.changed()
    return entry
  }

  /** Tool calls left waiting or not yet started, which a restart continues instead of failing. */
  kept(): ReadonlySet<string> {
    return new Set(
      Array.from(this.tools.values())
        .filter((tool) => tool.state === "gated" || tool.state === "waiting")
        .map((tool) => tool.id),
    )
  }
}

/** The execution the current fiber works for; set by SessionExecution around each drain. */
export const Current = Context.Reference<Activity | undefined>("@opencode/SessionContinuity/Current", {
  defaultValue: () => undefined,
})

export interface PendingRequest {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly kind: "permission" | "form"
  readonly messageID: string
  readonly callID: string
  readonly request: unknown
  readonly agent?: string
  readonly reply?: unknown
}

export interface RequestSource {
  readonly sessionID: SessionSchema.ID
  readonly messageID: string
  readonly callID: string
}

/** Whether two JSON values are equal, whatever order their object keys were built in. */
export const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )

const pendingRequest = (row: typeof PendingRequestTable.$inferSelect): PendingRequest => ({
  id: row.id,
  sessionID: row.session_id,
  kind: row.kind,
  messageID: row.message_id,
  callID: row.call_id,
  request: row.request,
  ...(row.agent === null ? {} : { agent: row.agent }),
  ...(row.reply === null ? {} : { reply: row.reply }),
})

/** The arguments of each `compact` overload, told apart by the mechanism. */
type TriggerCompact = [request: CheckpointRequest, options: TriggerCompactOptions]
type EndpointCompact = [request: CompactionRequest, options?: EndpointCompactOptions]
const triggers = (args: TriggerCompact | EndpointCompact): args is TriggerCompact => args[1]?.mechanism === "trigger"

export interface Options {
  /** Start with the gate closed; writes are refused until `resume`. */
  readonly paused?: boolean
}

export interface Interface {
  readonly status: Effect.Effect<Continuity.Status>
  /**
   * Stops new model calls and in-service tools, and resolves once every execution rests. Gives up after `timeout`
   * milliseconds (2 minutes by default), opening the gate again.
   */
  readonly pause: (options?: { readonly timeout?: number }) => Effect.Effect<Continuity.PauseResult>
  readonly resume: Effect.Effect<Continuity.Status>
  /** The service started paused and has not been resumed: refuse writes so a rollback cannot lose them. */
  readonly refusesWrites: () => boolean
  /** The process is shutting down: waits that survive a stop keep their records instead of settling. */
  readonly stopping: () => boolean
  /** Marks the process stopping. The server calls it before closing anything; SessionExecution's shutdown too. */
  readonly stop: Effect.Effect<void>
  readonly awaitOpen: Effect.Effect<void>
  readonly activity: (sessionID: SessionSchema.ID) => Activity
  readonly end: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** A step boundary: passes while open; while closed records `rest` and waits. */
  readonly boundary: (rest?: Rest) => Effect.Effect<void>
  /** A wait with a stored deadline, such as a retry backoff: the execution rests while it runs. */
  readonly idle: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Runs a tool call registered on the activity, once the gate is open. */
  readonly tool: <A, E, R>(
    activity: Activity,
    entry: ToolEntry,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  /**
   * A wait inside a tool call that survives a stop: a permission or question, a subagent, a runner command. The call
   * stops counting as busy, and its checkpoint `data` is stored for the next process. Plain `effect` for calls that
   * cannot be continued.
   */
  readonly wait: <A, E, R>(
    callID: string | undefined,
    effect: Effect.Effect<A, E, R>,
    data?: unknown,
  ) => Effect.Effect<A, E, R>
  /** Whether a wait inside this tool call would survive a stop. */
  readonly survives: (callID: string | undefined) => Effect.Effect<boolean>
  /** The checkpoint data handed back to a tool call that a restart continues. */
  readonly resumed: (callID: string) => Effect.Effect<unknown>
  /** Whether this tool call is one a restart continues, so it may find what it asked before. */
  readonly rerun: (callID: string | undefined) => Effect.Effect<boolean>
  /** Gates model calls outside a busy execution. */
  readonly client: (llm: LLMClientShape) => LLMClientShape
  readonly restored: (sessionID: SessionSchema.ID) => Effect.Effect<Restored>
  readonly save: (sessionID: SessionSchema.ID, rest: Rest) => Effect.Effect<void>
  readonly clearRest: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** The step's tools settled: its checkpoint and tool records go. */
  readonly clearStep: (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) => Effect.Effect<void>
  /** The execution reached a terminal: every record of the Session goes. */
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Whether the previous process stopped after a completed pause. */
  readonly rested: Effect.Effect<boolean>
  readonly settleRested: Effect.Effect<void>
  /** Permission requests and questions a surviving wait asked, kept for the rerun of the call after a restart. */
  readonly requests: {
    readonly add: (request: PendingRequest) => Effect.Effect<void>
    readonly reply: (id: string, reply: unknown) => Effect.Effect<void>
    readonly remove: (id: string) => Effect.Effect<void>
    readonly get: (id: string) => Effect.Effect<PendingRequest | undefined>
    /** What a tool call asked before the restart. */
    readonly find: (kind: PendingRequest["kind"], source: RequestSource) => Effect.Effect<PendingRequest | undefined>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContinuity") {}

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const bus = yield* Bus.Service
      const kv = yield* KV.Service
      const scope = yield* Scope.Scope
      const gate = Latch.makeUnsafe(!options.paused)
      const activities = new Map<SessionSchema.ID, Activity>()
      const models = new Set<Continuity.Work>()
      let state: Continuity.State = options.paused ? "paused" : "running"
      let startedPaused = options.paused === true
      let deadline: number | undefined
      let stopping = false
      let changes = Deferred.makeUnsafe<void>()
      let outcome: Deferred.Deferred<Continuity.PauseResult> | undefined

      const wake = () => {
        const signal = changes
        changes = Deferred.makeUnsafe()
        Deferred.doneUnsafe(signal, Exit.void)
      }

      // Only a pause in progress listens, so transitions cost nothing otherwise.
      const changed = () => {
        if (state === "pausing") wake()
      }

      const waiting = () => [...models, ...Array.from(activities.values()).flatMap((activity) => activity.busy())]
      const rested = () =>
        Array.from(activities.values())
          .filter((activity) => activity.rested)
          .map((activity) => activity.sessionID)

      const status = Effect.sync(
        (): Continuity.Status => ({
          state,
          startedPaused,
          ...(deadline === undefined ? {} : { deadline }),
          waiting: waiting(),
          rested: rested(),
          active: Array.from(activities.keys()),
        }),
      )

      // Until nothing keeps the pause `result` waiting, or it is no longer the pause in progress.
      const settle = (result: Deferred.Deferred<Continuity.PauseResult>, until: number) =>
        Effect.gen(function* () {
          let published = ""
          while (outcome === result) {
            const signal = changes
            const left = waiting()
            if (left.length === 0) return
            const key = JSON.stringify(left)
            if (key !== published) {
              published = key
              yield* bus.publish(Continuity.Event.Pausing, { deadline: until, waiting: left })
            }
            yield* Deferred.await(signal)
          }
        })

      const run = (result: Deferred.Deferred<Continuity.PauseResult>, until: number, timeout: number) =>
        Effect.gen(function* () {
          const settled = yield* settle(result, until).pipe(Effect.timeoutOption(timeout))
          // Resumed meanwhile, and maybe paused again: that resume or pause decides the state.
          if (outcome !== result) return { paused: false as const, waiting: waiting() }
          if (Option.isSome(settled)) {
            state = "paused"
            deadline = undefined
            const sessions = rested()
            yield* kv.set(RESTED, true)
            yield* bus.publish(Continuity.Event.Paused, { rested: sessions })
            return { paused: true as const, rested: sessions }
          }
          const left = waiting()
          state = "running"
          deadline = undefined
          gate.openUnsafe()
          yield* bus.publish(Continuity.Event.Expired, { waiting: left })
          return { paused: false as const, waiting: left }
        })

      const pause: Interface["pause"] = (input) =>
        Effect.gen(function* () {
          if (state === "paused") return { paused: true as const, rested: rested() }
          if (state === "pausing" && outcome) return yield* Deferred.await(outcome)
          const timeout = input?.timeout ?? PAUSE_TIMEOUT
          const result = Deferred.makeUnsafe<Continuity.PauseResult>()
          const until = (yield* Clock.currentTimeMillis) + timeout
          state = "pausing"
          deadline = until
          outcome = result
          gate.closeUnsafe()
          // The pause outlives the request that asked for it, so a dropped connection cannot leave the gate shut.
          yield* run(result, until, timeout).pipe(
            Effect.flatMap((value) => Deferred.succeed(result, value)),
            Effect.ensuring(
              Effect.sync(() => {
                if (outcome === result) outcome = undefined
              }),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
          return yield* Deferred.await(result)
        })

      const resume = Effect.gen(function* () {
        if (state === "running") return yield* status
        const restart = startedPaused
        state = "running"
        startedPaused = false
        deadline = undefined
        // Ends a pause in progress: its loop sees it is no longer the current one.
        outcome = undefined
        gate.openUnsafe()
        wake()
        // After a paused start the restart sweep reads the marker; otherwise nothing stopped and it is stale.
        if (!restart) yield* kv.remove(RESTED)
        yield* bus.publish(Continuity.Event.Resumed, {})
        return yield* status
      })

      const saveTool = (sessionID: SessionSchema.ID, callID: string, messageID: SessionMessage.ID, data: unknown) =>
        db
          .insert(SessionRestTable)
          .values({ session_id: sessionID, call_id: callID, message_id: messageID, data: data ?? null })
          .onConflictDoUpdate({
            target: [SessionRestTable.session_id, SessionRestTable.call_id],
            set: { message_id: messageID, data: data ?? null, time_updated: Date.now() },
          })
          .run()
          .pipe(Effect.orDie)

      const deleteTool = (sessionID: SessionSchema.ID, callID: string) =>
        db
          .delete(SessionRestTable)
          .where(and(eq(SessionRestTable.session_id, sessionID), eq(SessionRestTable.call_id, callID)))
          .run()
          .pipe(Effect.orDie)

      const save: Interface["save"] = (sessionID, rest) =>
        db
          .insert(SessionRestTable)
          .values({ session_id: sessionID, call_id: "", data: encodeRest(rest) })
          .onConflictDoUpdate({
            target: [SessionRestTable.session_id, SessionRestTable.call_id],
            set: { data: encodeRest(rest), time_updated: Date.now() },
          })
          .run()
          .pipe(Effect.orDie)

      const clearRest: Interface["clearRest"] = (sessionID) => deleteTool(sessionID, "")

      const interrupted = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)

      const tool: Interface["tool"] = (activity, entry, effect) =>
        Effect.gen(function* () {
          // A call restored without data runs again from its beginning; from here it is new work.
          if (entry.rerun && entry.resume === undefined) yield* deleteTool(activity.sessionID, entry.id)
          if (!Latch.isOpen(gate)) {
            yield* saveTool(activity.sessionID, entry.id, entry.messageID, entry.resume)
            entry.state = "gated"
            changed()
            yield* gate.await
            entry.state = "busy"
            changed()
            yield* deleteTool(activity.sessionID, entry.id)
          }
          return yield* effect
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (stopping && interrupted(exit) && entry.state !== "busy") return
              entry.state = "done"
              changed()
            }),
          ),
        )

      const wait: Interface["wait"] = (callID, effect, data) =>
        Effect.gen(function* () {
          const activity = yield* Current
          const entry = callID === undefined ? undefined : activity?.tools.get(callID)
          if (activity === undefined || entry === undefined || !entry.survives || entry.state !== "busy")
            return yield* effect
          yield* saveTool(activity.sessionID, entry.id, entry.messageID, data)
          entry.state = "waiting"
          changed()
          const exit = yield* Effect.exit(effect)
          if (stopping && interrupted(exit)) return yield* exit
          // An answer that arrives while paused holds the tool here; a stop then reruns it with the stored answer.
          if (Exit.isSuccess(exit)) yield* gate.await
          entry.state = "busy"
          changed()
          yield* deleteTool(activity.sessionID, entry.id)
          return yield* exit
        })

      // A busy execution finishes its step; every other model call waits for the gate.
      const enter = (name: string) =>
        Effect.gen(function* () {
          const activity = yield* Current
          if (activity === undefined || activity.rested) yield* gate.await
          return {
            acquire: Effect.sync(() => {
              const work: Continuity.Work = {
                ...(activity ? { sessionID: activity.sessionID } : {}),
                kind: "model",
                name,
              }
              models.add(work)
              changed()
              return work
            }),
            release: (work: Continuity.Work) =>
              Effect.sync(() => {
                models.delete(work)
                changed()
              }),
          }
        })

      const model = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(enter(name), (call) => Effect.acquireUseRelease(call.acquire, () => effect, call.release))

      const client: Interface["client"] = (llm) => {
        function compact(
          request: CheckpointRequest,
          options: TriggerCompactOptions,
        ): Effect.Effect<CompactionCheckpointResponse, AIError>
        function compact(
          request: CompactionRequest,
          options?: EndpointCompactOptions,
        ): Effect.Effect<CompactionResponse, AIError>
        // `llm.compact` refuses a route that cannot compact, as without the gate.
        function compact(...args: TriggerCompact | EndpointCompact) {
          const name = String(args[0].model.id)
          return triggers(args) ? model(name, llm.compact(...args)) : model(name, llm.compact(...args))
        }
        return {
          stream: (request, options) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const call = yield* enter(String(request.model.id))
                yield* Effect.acquireRelease(call.acquire, call.release)
                return llm.stream(request, options)
              }),
            ),
          generate: (request, options) => model(String(request.model.id), llm.generate(request, options)),
          compact,
        }
      }

      const restored: Interface["restored"] = Effect.fnUntraced(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(SessionRestTable)
          .where(eq(SessionRestTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        const own = rows.find((row) => row.call_id === "")
        const rest = own === undefined ? undefined : Option.getOrUndefined(decodeRest(own.data))
        return {
          ...(rest === undefined ? {} : { rest }),
          tools: new Map(
            rows
              .filter((row) => row.call_id !== "")
              .map((row) => [row.call_id, { messageID: row.message_id, data: row.data ?? undefined }] as const),
          ),
        }
      })

      const clearStep: Interface["clearStep"] = (sessionID, messageID) =>
        Effect.all(
          [
            db
              .delete(SessionRestTable)
              .where(
                and(
                  eq(SessionRestTable.session_id, sessionID),
                  or(eq(SessionRestTable.call_id, ""), eq(SessionRestTable.message_id, messageID)),
                ),
              )
              .run(),
            // Requests a rerun call did not ask again.
            db
              .delete(PendingRequestTable)
              .where(and(eq(PendingRequestTable.session_id, sessionID), eq(PendingRequestTable.message_id, messageID)))
              .run(),
          ],
          { discard: true },
        ).pipe(Effect.orDie)

      const clear: Interface["clear"] = (sessionID) =>
        Effect.all(
          [
            db.delete(SessionRestTable).where(eq(SessionRestTable.session_id, sessionID)).run(),
            db.delete(PendingRequestTable).where(eq(PendingRequestTable.session_id, sessionID)).run(),
          ],
          { discard: true },
        ).pipe(Effect.orDie)

      const requests: Interface["requests"] = {
        add: (request) =>
          db
            .insert(PendingRequestTable)
            .values({
              id: request.id,
              session_id: request.sessionID,
              kind: request.kind,
              message_id: request.messageID,
              call_id: request.callID,
              request: request.request,
              agent: request.agent ?? null,
              reply: request.reply ?? null,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie, Effect.asVoid),
        reply: (id, reply) =>
          db
            .update(PendingRequestTable)
            .set({ reply, time_updated: Date.now() })
            .where(eq(PendingRequestTable.id, id))
            .run()
            .pipe(Effect.orDie, Effect.asVoid),
        remove: (id) =>
          db.delete(PendingRequestTable).where(eq(PendingRequestTable.id, id)).run().pipe(Effect.orDie, Effect.asVoid),
        get: (id) =>
          db
            .select()
            .from(PendingRequestTable)
            .where(eq(PendingRequestTable.id, id))
            .get()
            .pipe(
              Effect.orDie,
              Effect.map((row) => (row === undefined ? undefined : pendingRequest(row))),
            ),
        find: (kind, source) =>
          db
            .select()
            .from(PendingRequestTable)
            .where(
              and(
                eq(PendingRequestTable.kind, kind),
                eq(PendingRequestTable.session_id, source.sessionID),
                eq(PendingRequestTable.message_id, source.messageID),
                eq(PendingRequestTable.call_id, source.callID),
              ),
            )
            .get()
            .pipe(
              Effect.orDie,
              Effect.map((row) => (row === undefined ? undefined : pendingRequest(row))),
            ),
      }

      return Service.of({
        status,
        pause,
        resume,
        refusesWrites: () => startedPaused && state !== "running",
        stopping: () => stopping,
        stop: Effect.sync(() => {
          stopping = true
        }),
        awaitOpen: gate.await,
        activity: (sessionID) => {
          const existing = activities.get(sessionID)
          if (existing) return existing
          const activity = new Activity(sessionID, changed)
          activities.set(sessionID, activity)
          changed()
          return activity
        },
        end: (sessionID) =>
          Effect.sync(() => {
            activities.delete(sessionID)
            changed()
          }),
        boundary: (rest) =>
          Effect.gen(function* () {
            if (Latch.isOpen(gate)) return
            const activity = yield* Current
            if (activity === undefined) return yield* gate.await
            if (rest) yield* save(activity.sessionID, rest)
            activity.resting++
            changed()
            yield* gate.await.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  activity.resting--
                  changed()
                }),
              ),
            )
            if (rest) yield* clearRest(activity.sessionID)
          }),
        idle: (effect) =>
          Effect.gen(function* () {
            const activity = yield* Current
            if (activity === undefined) return yield* effect
            activity.resting++
            changed()
            return yield* effect.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  activity.resting--
                  changed()
                }),
              ),
            )
          }),
        tool,
        wait,
        survives: (callID) =>
          Effect.gen(function* () {
            const activity = yield* Current
            const entry = callID === undefined ? undefined : activity?.tools.get(callID)
            return entry !== undefined && entry.survives && entry.state === "busy"
          }),
        resumed: (callID) =>
          Effect.gen(function* () {
            const activity = yield* Current
            return activity?.tools.get(callID)?.resume
          }),
        rerun: (callID) =>
          Effect.gen(function* () {
            const activity = yield* Current
            return callID !== undefined && activity?.tools.get(callID)?.rerun === true
          }),
        client,
        restored,
        save,
        clearRest,
        clearStep,
        clear,
        rested: Effect.map(kv.get(RESTED), (value) => value !== undefined),
        settleRested: kv.remove(RESTED),
        requests,
      })
    }),
  )

/** Never pauses and stores nothing: for code run outside the service, such as scripts and focused tests. */
export const noopLayer = Layer.sync(Service, () => {
  const status: Continuity.Status = { state: "running", startedPaused: false, waiting: [], rested: [], active: [] }
  return Service.of({
    status: Effect.succeed(status),
    pause: () => Effect.succeed({ paused: true, rested: [] }),
    resume: Effect.succeed(status),
    refusesWrites: () => false,
    stopping: () => false,
    stop: Effect.void,
    awaitOpen: Effect.void,
    activity: (sessionID) => new Activity(sessionID, () => {}),
    end: () => Effect.void,
    boundary: () => Effect.void,
    idle: (effect) => effect,
    tool: (_activity, _entry, effect) => effect,
    wait: (_callID, effect) => effect,
    survives: () => Effect.succeed(false),
    resumed: () => Effect.undefined,
    rerun: () => Effect.succeed(false),
    client: (llm) => llm,
    restored: () => Effect.succeed({ tools: new Map() }),
    save: () => Effect.void,
    clearRest: () => Effect.void,
    clearStep: () => Effect.void,
    clear: () => Effect.void,
    rested: Effect.succeed(false),
    settleRested: Effect.void,
    requests: {
      add: () => Effect.void,
      reply: () => Effect.void,
      remove: () => Effect.void,
      get: () => Effect.undefined,
      find: () => Effect.undefined,
    },
  })
})

export const configured = (options: Options = {}) =>
  makeGlobalNode({ service: Service, layer: layer(options), deps: [Database.node, Bus.node, KV.node] })
export const node = configured()

/**
 * The model client where the service runs, in place of `LayerNodePlatform.llmClient`: `base`, the real client unless
 * a test gives its fake, with every call gated by `client`.
 */
export const llmClient = (base: Layer.Layer<LLMClientService, never, RequestExecutor.Service> = LLMClient.layer) =>
  makeGlobalNode({
    service: LLMClient.Service,
    layer: Layer.effect(
      LLMClient.Service,
      Effect.gen(function* () {
        const continuity = yield* Service
        const llm = yield* LLMClient.Service
        return continuity.client(llm)
      }),
    ).pipe(Layer.provide(base)),
    deps: [node, requestExecutor],
  })
