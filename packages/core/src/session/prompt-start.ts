export * as SessionPromptStart from "./prompt-start.js"

import { createHash } from "node:crypto"
import { ToolDefinition } from "@opencode/ai/effect"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import { createPatch } from "diff"
import { eq, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import { Instructions } from "../instructions/index.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerModels } from "../pacer/models.js"
import { PacerWarmth } from "../pacer/warmth.js"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { PromptStartTable, PromptToolsTable } from "./prompt-start.sql.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

// A warm chat's prompt never changes (the workspace's spec `docs/specs/frozen-prefix.md`). What a request sends before
// the chat's messages (the agent's prompt and the tool definitions) is recorded at the chat's cold points and sent
// byte for byte until the next one: its first step, the first step after a completed compaction, after its cache went
// cold, and after a switch of its model or agent. Whatever changed meanwhile waits for the next, and the chat is told
// of it at its next step by a reminder: a stored message after its history, as a changed instruction file or a new
// date arrives, so the cache is read up to it. The memory tools a chat is offered (`MemoryOffer`) and CPP's web tools
// (`PacerOffer`) are decided with the rest. Off (CPP's `pacer.freeze_prompt` for a chat on it, else openforge's
// `freeze_prompt`), each request takes what is current, as before, and the record goes: turned on again, the start of
// that moment is recorded.

/** A provider's prompt cache lasts this long after a request unless its route says otherwise. */
export const CACHE_TTL = 5 * 60_000
/** Definition lists held decoded, by hash; past it the one used longest ago goes. */
export const HELD = 256

export interface Start {
  /** The agent's prompt, the request's first system part; undefined when the request carries none. */
  readonly system: string | undefined
  readonly definitions: ReadonlyArray<ToolDefinition>
  /** The reminder stored for this step, which its request carries after the history. */
  readonly reminder?: { readonly id: SessionMessage.ID; readonly text: string }
}

export interface Input {
  readonly kind: SessionRequestKind
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
  readonly model: { readonly providerID: string; readonly id: string }
  /** The route's cache time (`5m`, `1h`), when it sets one. */
  readonly ttl?: string
  /** The start as it is now: the agent's prompt, and the definitions, which are worked out only when needed. */
  readonly system: string | undefined
  readonly definitions: Effect.Effect<ReadonlyArray<ToolDefinition>>
}

export interface Interface {
  /**
   * The start the request sends. A step at a cold point records the current one; a warm step sends the recorded one
   * and stores a reminder of what changed since the chat was last told; a compaction or one-off generation sends the
   * recorded one whenever the chat's agent recorded it.
   */
  readonly resolve: (input: Input) => Effect.Effect<Start>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPromptStart") {}

type Db = Database.Interface["db"]
type Row = NonNullable<Effect.Success<ReturnType<typeof read>>>

const PACER: string = PacerEndpoint.id
const Definitions = Schema.Array(ToolDefinition)
// Stored as JSON; decoded back into `ToolDefinition`s, whose JSON is the same.
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Definitions))
type Held = Map<string, ReadonlyArray<ToolDefinition>>

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Effect.serviceOption(Database.Service)
    const config = yield* Effect.serviceOption(Config.Service)
    const catalogs = yield* PacerModels.Service
    const warmth = yield* PacerWarmth.Service
    const bus = yield* Bus.Service
    // Definition lists decoded this run, by hash: a warm step decodes none.
    const held: Held = new Map()

    const enabled = Effect.fnUntraced(function* (providerID: string) {
      if (providerID === PACER) return (yield* catalogs.get())?.pacer?.freezePrompt !== false
      if (Option.isNone(config)) return true
      return Config.latest(yield* config.value.entries(), "freeze_prompt") !== false
    })

    /** Whether the chat's cache went cold since its last request, as far as it can be known. */
    const cold = Effect.fnUntraced(function* (input: Input, row: Row) {
      const now = yield* Clock.currentTimeMillis
      const last = Math.max(row.recorded ?? 0, row.stepped ?? 0)
      if (input.model.providerID !== PACER) return now - last >= ttl(input.ttl)
      // CPP pings a chat to keep it warm, so only its view tells, and only one read since the chat's last request.
      const view = yield* warmth.get(input.sessionID)
      if (!view || view.asOf <= last) return false
      return now >= (view.warm ? (view.coldAt ?? view.warmUntil ?? Infinity) : view.asOf)
    })

    /** Whether the record still holds: no cold point came since it was recorded. */
    const warm = Effect.fnUntraced(function* (input: Input, row: Row) {
      if (row.agent !== input.agent || row.provider !== input.model.providerID || row.model !== input.model.id)
        return false
      if (row.compaction !== row.latest) return false
      return !(yield* cold(input, row))
    })

    /** Stores a reminder of what changed since the chat was last told, and what it was told; none when nothing did. */
    const remind = Effect.fnUntraced(function* (db: Db, input: Input, row: Row) {
      const now = yield* current(input)
      const system = now.system ?? row.toldSystem
      // The registry hands the same definition objects step after step, so an unchanged step is told apart by
      // identity, before anything is serialised or hashed.
      if (system === row.toldSystem && same(held.get(row.toldTools ?? ""), now.definitions)) return undefined
      const value = json(now.definitions)
      const hash = digest(value)
      if (hash === row.toldTools && system === row.toldSystem) {
        hold(held, hash, now.definitions)
        return undefined
      }
      const told =
        hash === row.toldTools
          ? now.definitions
          : ((yield* definitionsOf(db, held, row.toldTools ?? "")) ?? now.definitions)
      const text = reminder(row.toldSystem, system, told, now.definitions)
      const published =
        text === undefined
          ? undefined
          : yield* bus.publish(SessionEvent.Synthetic, {
              sessionID: input.sessionID,
              text,
              description: "What changed in the chat's prompt, from its next cold point",
              metadata: { promptStart: true },
            })
      yield* store(db, held, hash, value, now.definitions)
      yield* db
        .update(PromptStartTable)
        .set({ told_system: system ?? null, told_tools: hash })
        .where(eq(PromptStartTable.session_id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      return published && text !== undefined ? { id: SessionMessage.ID.fromEvent(published.id), text } : undefined
    })

    // Untraced: it runs on every request, and its span would cost more than its work on a warm step.
    const resolve = Effect.fnUntraced(function* (input: Input) {
      if (Option.isNone(database) || input.kind === "title") return yield* current(input)
      const db = database.value.db
      const row = yield* read(db, input.sessionID)
      // A chat that isn't stored has nothing to keep its record with.
      if (!row) return yield* current(input)
      const kept = row.tools === null ? undefined : row
      if (!(yield* enabled(input.model.providerID))) {
        if (kept && input.kind === "primary") yield* forget(db, input.sessionID)
        return yield* current(input)
      }
      if (input.kind !== "primary") {
        const recorded = kept?.agent === input.agent ? yield* recall(db, held, kept, input) : undefined
        return recorded ?? (yield* current(input))
      }
      const recorded = kept && (yield* warm(input, kept)) ? yield* recall(db, held, kept, input) : undefined
      if (kept && recorded) {
        const told = yield* remind(db, input, kept)
        return told ? { ...recorded, reminder: told } : recorded
      }
      const start = yield* current(input)
      yield* record(db, held, input, start, row.latest)
      return start
    })

    return Service.of({ resolve })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Config.node, PacerModels.node, PacerWarmth.node, Bus.node],
})

const current = (input: Input) =>
  Effect.map(input.definitions, (definitions): Start => ({ system: input.system, definitions }))

/**
 * The chat's record with, beside it, the `seq` of its latest completed compaction and the time of its latest step:
 * one statement on the chat's row, its record's, and two lookups on the messages' type index. Prepared once per
 * database, since building it each request cost several times what running it does.
 */
export const read = (db: Db, sessionID: SessionSchema.ID) =>
  (statements.get(db) ?? prepare(db)).get({ sessionID }).pipe(Effect.orDie)

const statements = new WeakMap<Db, ReturnType<typeof statement>>()

function prepare(db: Db) {
  const prepared = statement(db)
  statements.set(db, prepared)
  return prepared
}

function statement(db: Db) {
  return db
    .select({
      agent: PromptStartTable.agent,
      provider: PromptStartTable.provider_id,
      model: PromptStartTable.model_id,
      system: PromptStartTable.system,
      tools: PromptStartTable.tools,
      toldSystem: PromptStartTable.told_system,
      toldTools: PromptStartTable.told_tools,
      compaction: PromptStartTable.compaction,
      recorded: PromptStartTable.time_created,
      latest: sql<
        number | null
      >`(select ${SessionMessageTable.seq} from ${SessionMessageTable} where ${SessionMessageTable.session_id} = ${SessionTable.id} and ${SessionMessageTable.type} = 'compaction' and json_extract(${SessionMessageTable.data}, '$.status') = 'completed' order by ${SessionMessageTable.seq} desc limit 1)`,
      stepped: sql<
        number | null
      >`(select ${SessionMessageTable.time_created} from ${SessionMessageTable} where ${SessionMessageTable.session_id} = ${SessionTable.id} and ${SessionMessageTable.type} = 'assistant' order by ${SessionMessageTable.seq} desc limit 1)`,
    })
    .from(SessionTable)
    .leftJoin(PromptStartTable, eq(PromptStartTable.session_id, SessionTable.id))
    .where(eq(SessionTable.id, sql.placeholder("sessionID")))
    .prepare()
}

/** The recorded start, its definitions decoded once per process; undefined when they can't be read. */
const recall = (db: Db, held: Held, row: Row, input: Input) =>
  Effect.map(
    definitionsOf(db, held, row.tools ?? ""),
    (definitions): Start | undefined => definitions && { system: row.system ?? input.system, definitions },
  )

const definitionsOf = Effect.fnUntraced(function* (db: Db, held: Held, hash: string) {
  const found =
    held.get(hash) ??
    (yield* db
      .select({ value: PromptToolsTable.value })
      .from(PromptToolsTable)
      .where(eq(PromptToolsTable.hash, hash))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((stored) => stored && Option.getOrUndefined(decode(stored.value))),
      ))
  if (found) hold(held, hash, found)
  return found
})

const store = (db: Db, held: Held, hash: string, value: string, definitions: ReadonlyArray<ToolDefinition>) => {
  hold(held, hash, definitions)
  return db.insert(PromptToolsTable).values({ hash, value }).onConflictDoNothing().run().pipe(Effect.orDie)
}

const record = Effect.fnUntraced(function* (db: Db, held: Held, input: Input, start: Start, compaction: number | null) {
  const value = json(start.definitions)
  const hash = digest(value)
  const values = {
    agent: input.agent,
    provider_id: input.model.providerID,
    model_id: input.model.id,
    system: start.system ?? null,
    tools: hash,
    told_system: start.system ?? null,
    told_tools: hash,
    compaction,
    time_created: yield* Clock.currentTimeMillis,
  }
  yield* store(db, held, hash, value, start.definitions)
  yield* db
    .insert(PromptStartTable)
    .values({ session_id: input.sessionID, ...values })
    .onConflictDoUpdate({ target: PromptStartTable.session_id, set: values })
    .run()
    .pipe(Effect.orDie)
})

const forget = (db: Db, sessionID: SessionSchema.ID) =>
  db.delete(PromptStartTable).where(eq(PromptStartTable.session_id, sessionID)).run().pipe(Effect.orDie, Effect.asVoid)

/**
 * The reminder's text: the agent's prompt as a diff of the passages that changed, or the whole new prompt when that
 * is shorter; each tool whose description or input changed, with both; each that went; each that comes. Undefined
 * when none of that changed (only the tools' order, say).
 */
export function reminder(
  before: string | null | undefined,
  after: string | null | undefined,
  told: ReadonlyArray<ToolDefinition>,
  now: ReadonlyArray<ToolDefinition>,
) {
  const tools = Instructions.diffByKey(
    told,
    now,
    (tool) => tool.name,
    (previous, current) =>
      previous.description !== current.description ||
      JSON.stringify(previous.inputSchema) !== JSON.stringify(current.inputSchema),
  )
  const parts = [
    ...(before && after && before !== after ? [prompt(before, after)] : []),
    ...tools.changed.map(({ current }) =>
      [
        `The tool ${current.name} changed; its calls follow this from now on:`,
        `Description: ${current.description}`,
        `Input: ${JSON.stringify(current.inputSchema)}`,
      ].join("\n"),
    ),
    ...tools.removed.map((tool) => `The tool ${tool.name} is gone: its calls answer that it is unavailable.`),
    ...tools.added.map(
      (tool) =>
        `A new tool, ${tool.name}, comes with this chat's next cold point (such as a compaction); until then it is in no list you have.`,
    ),
  ]
  if (parts.length === 0) return undefined
  return [
    "While this chat's prompt cache is warm, its system prompt and tool list stay as they were sent; these changes apply from now on, and come into them at its next cold point:",
    ...parts,
  ].join("\n\n")
}

function prompt(before: string, after: string) {
  const patch = createPatch("prompt", before, after, "", "", { context: 3 })
  const diff = [
    "The agent's prompt changed; the new passages apply from now on. Here's the diff:",
    "```diff",
    patch.slice(patch.indexOf("@@")).trimEnd(),
    "```",
  ].join("\n")
  const whole = `The agent's prompt changed; from now on it is:\n${after}`
  return diff.length < whole.length ? diff : whole
}

/** Whether two definition lists hold the same objects in the same order. */
function same(left: ReadonlyArray<ToolDefinition> | undefined, right: ReadonlyArray<ToolDefinition>) {
  return (
    left !== undefined && left.length === right.length && left.every((definition, index) => definition === right[index])
  )
}

/** Each definition's JSON, once per object: the registry's definitions live across steps and chats. */
const serialised = new WeakMap<ToolDefinition, string>()

/** The list's JSON, as `JSON.stringify` writes it, from each definition's. */
function json(definitions: ReadonlyArray<ToolDefinition>) {
  return `[${definitions
    .map((definition) => {
      const found = serialised.get(definition)
      if (found !== undefined) return found
      const value = JSON.stringify(definition)
      serialised.set(definition, value)
      return value
    })
    .join(",")}]`
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function hold(held: Held, hash: string, definitions: ReadonlyArray<ToolDefinition>) {
  held.delete(hash)
  held.set(hash, definitions)
  if (held.size > HELD) held.delete(held.keys().next().value!)
}

function ttl(value: string | undefined) {
  const match = value === undefined ? null : /^(\d+)(ms|s|m|h|d)$/.exec(value)
  if (!match) return CACHE_TTL
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "ms" | "s" | "m" | "h" | "d"]
  return Number(match[1]) * unit
}
