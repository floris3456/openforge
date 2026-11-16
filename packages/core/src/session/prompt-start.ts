export * as SessionPromptStart from "./prompt-start.js"

import { createHash } from "node:crypto"
import { SystemPart, ToolDefinition } from "@opencode/ai/effect"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import { createPatch, diffArrays } from "diff"
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
import { PromptStartTable, PromptSystemTable, PromptToolsTable } from "./prompt-start.sql.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

// A warm chat's prompt never changes (the workspace's spec `docs/specs/frozen-prefix.md`). What a request sends before
// the chat's messages (every system part and the tool definitions, as finally given to the provider after every
// transform and hook) is recorded at the chat's cold points and sent byte for byte until the next one: its first
// step, the first step after a completed compaction, after its cache went cold, after a switch of its model or agent,
// and after the provider refused the prompt itself. Whatever changed meanwhile waits for the next, and the chat is told
// of it at its next step by a reminder: a stored message after its history, as a changed instruction file or a new
// date arrives, so the cache is read up to it. CPP's tools a chat is offered, its memory tools among them
// (`PacerOffer`), are decided with the rest. Off (CPP's `pacer.freeze_prompt` for a chat on it, else openforge's
// `freeze_prompt`), each request takes what is current, as before, and the record goes: turned on again, the start of
// that moment is recorded.

/** A provider's prompt cache lasts this long after a request unless its route says otherwise. */
export const CACHE_TTL = 5 * 60_000
/** Definition and system part lists held decoded, by hash, each kind; past it the one used longest ago goes. */
export const HELD = 256

export interface Start {
  /** The system parts the request sends. */
  readonly system: ReadonlyArray<SystemPart>
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
  /**
   * The start as it is now, as the request would send it: every system part and the tool definitions after all
   * transforms and hooks, each definition under the name it is sent by. A list unchanged since the step before should
   * hold the same definition objects, which an unchanged step compares by identity.
   */
  readonly system: ReadonlyArray<SystemPart>
  readonly definitions: ReadonlyArray<ToolDefinition>
  /** Whether the first system part is the agent's prompt, which the reminder calls so. */
  readonly prompt?: boolean
  /**
   * Tools that leave the direct list for Code Mode: a warm chat that has one as a direct tool keeps calling it so, and
   * its catalog gets it at the next cold point, so its reminder doesn't call it gone.
   */
  readonly moved?: ReadonlySet<string>
  /**
   * Given for a record from before the system parts were recorded (`legacy`): `system` and `definitions` are then the
   * start as 0.0.50 built it, which the step sends and records, and `now` the start as it is, which its reminder
   * compares.
   */
  readonly now?: Pick<Start, "system" | "definitions">
}

/** A record from before the system parts were: the agent's prompt and the definitions before the hooks. */
export interface Legacy {
  readonly system: string | undefined
  readonly definitions: ReadonlyArray<ToolDefinition>
}

/** What tells whether a chat's record holds for its next step. */
export type Chat = Pick<Input, "sessionID" | "agent" | "model" | "ttl">

export interface Interface {
  /**
   * The start the request sends. A step at a cold point records the current one; a warm step sends the recorded one
   * and stores a reminder of what changed since the chat was last told; a compaction or one-off generation sends the
   * recorded one whenever the chat's agent recorded it.
   */
  readonly resolve: (input: Input) => Effect.Effect<Start>
  /**
   * The definitions the chat's next step sends as recorded, while its record holds (no cold point since); undefined
   * at a cold point or with nothing recorded. Code Mode's catalog follows them (`SessionContext`).
   */
  readonly recorded: (input: Chat) => Effect.Effect<ReadonlyArray<ToolDefinition> | undefined>
  /**
   * The chat's record when it is from before the system parts were recorded and still holds: its step builds the start
   * from it as 0.0.50 did (the agent's prompt as the first part, the definitions the hooks reshape), so the bytes match
   * what 0.0.50 sent, and `resolve` records that with `now`. Undefined otherwise, at no cost once the chat's record is
   * known to hold parts.
   */
  readonly legacy: (input: Chat & Pick<Input, "kind">) => Effect.Effect<Legacy | undefined>
  /**
   * The provider refused the chat's prompt itself (`PacerAnswers.refused`): its record goes, and its next step records
   * the start as it is then. A refused prompt is in no cache, so nothing is lost.
   */
  readonly refused: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPromptStart") {}

type Db = Database.Interface["db"]
type Row = NonNullable<Effect.Success<ReturnType<typeof read>>>

const PACER: string = PacerEndpoint.id
// Stored as JSON; decoded back into `ToolDefinition`s and `SystemPart`s, whose JSON is the same.
const decodeTools = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ToolDefinition)))
const decodeParts = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(SystemPart)))
type Held<A> = Map<string, ReadonlyArray<A>>

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Effect.serviceOption(Database.Service)
    const config = yield* Effect.serviceOption(Config.Service)
    const catalogs = yield* PacerModels.Service
    const warmth = yield* PacerWarmth.Service
    const bus = yield* Bus.Service
    // Lists decoded this run, by hash: a warm step decodes none.
    const tools: Held<ToolDefinition> = new Map()
    const parts: Held<SystemPart> = new Map()
    const definitionsOf = (db: Db, hash: string | null) =>
      heldOrRead(db, tools, PromptToolsTable, decodeTools, hash ?? "")
    const partsOf = (db: Db, hash: string | null) => heldOrRead(db, parts, PromptSystemTable, decodeParts, hash ?? "")
    // Chats whose record is known to be no `legacy` one: it holds parts, or will when it is first made.
    const modern = new Set<SessionSchema.ID>()

    const enabled = Effect.fnUntraced(function* (providerID: string) {
      if (providerID === PACER) return (yield* catalogs.get())?.pacer?.freezePrompt !== false
      if (Option.isNone(config)) return true
      return Config.latest(yield* config.value.entries(), "freeze_prompt") !== false
    })

    /** Whether the chat's cache went cold since its last request, as far as it can be known. */
    const cold = Effect.fnUntraced(function* (input: Chat, row: Row) {
      const now = yield* Clock.currentTimeMillis
      const last = Math.max(row.recorded ?? 0, row.stepped ?? 0)
      if (input.model.providerID !== PACER) return now - last >= ttl(input.ttl)
      // CPP pings a chat to keep it warm, so only its view tells, and only one read since the chat's last request.
      const view = yield* warmth.get(input.sessionID)
      if (!view || view.asOf <= last) return false
      return now >= (view.warm ? (view.coldAt ?? view.warmUntil ?? Infinity) : view.asOf)
    })

    /** Whether the record still holds: no cold point came since it was recorded. */
    const warm = Effect.fnUntraced(function* (input: Chat, row: Row) {
      if (row.agent !== input.agent || row.provider !== input.model.providerID || row.model !== input.model.id)
        return false
      if (row.compaction !== row.latest) return false
      return !(yield* cold(input, row))
    })

    /** The recorded start, its lists decoded once per process; undefined when they can't be read. */
    const recall = Effect.fnUntraced(function* (db: Db, row: Row) {
      const system = yield* partsOf(db, row.parts)
      const definitions = system && (yield* definitionsOf(db, row.tools))
      return definitions && ({ system, definitions } satisfies Start)
    })

    /** Stores a reminder of what changed since the chat was last told, and what it was told; none when nothing did. */
    const remind = Effect.fnUntraced(function* (db: Db, input: Input, row: Row, recorded: Start) {
      // Told what was recorded, as a chat is until its first reminder, it has the lists already.
      const toldTools = row.toldTools === row.tools ? recorded.definitions : yield* definitionsOf(db, row.toldTools)
      const toldParts = row.toldParts === row.parts ? recorded.system : yield* partsOf(db, row.toldParts)
      // An unchanged step hands the same definition objects as the step before (`SessionModelRequest` keeps them),
      // and system parts built anew that read the same: compared by identity, then by their strings, before anything
      // is serialised or hashed.
      if (toldTools && toldParts && equalList(toldParts, input.system)) {
        if (sameObjects(toldTools, input.definitions)) return undefined
        if (equalList(toldTools, input.definitions)) {
          // Equal field for field and in the same key order, so the same JSON: held, a later step tells by identity.
          hold(tools, row.toldTools ?? "", input.definitions)
          return undefined
        }
      }
      const systemValue = JSON.stringify(input.system)
      const systemHash = digest(systemValue)
      const toolsValue = json(input.definitions)
      const toolsHash = digest(toolsValue)
      const text = reminder({
        before: toldParts ?? input.system,
        after: input.system,
        prompt: input.prompt === true,
        told: (toldTools ?? input.definitions).filter(
          (tool) => input.moved?.has(tool.name) !== true || input.definitions.some((now) => now.name === tool.name),
        ),
        now: input.definitions,
      })
      const published =
        text === undefined
          ? undefined
          : yield* bus.publish(SessionEvent.Synthetic, {
              sessionID: input.sessionID,
              text,
              description: "What changed in the chat's prompt, from its next cold point",
              metadata: { promptStart: true },
            })
      yield* store(db, parts, PromptSystemTable, systemHash, systemValue, input.system)
      yield* store(db, tools, PromptToolsTable, toolsHash, toolsValue, input.definitions)
      yield* db
        .update(PromptStartTable)
        .set({ told_parts: systemHash, told_tools: toolsHash })
        .where(eq(PromptStartTable.session_id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      return published && text !== undefined ? { id: SessionMessage.ID.fromEvent(published.id), text } : undefined
    })

    const record = Effect.fnUntraced(function* (db: Db, input: Input, compaction: number | null) {
      const systemValue = JSON.stringify(input.system)
      const systemHash = digest(systemValue)
      const toolsValue = json(input.definitions)
      const toolsHash = digest(toolsValue)
      const values = {
        agent: input.agent,
        provider_id: input.model.providerID,
        model_id: input.model.id,
        system: null,
        tools: toolsHash,
        told_system: null,
        told_tools: toolsHash,
        parts: systemHash,
        told_parts: systemHash,
        compaction,
        time_created: yield* Clock.currentTimeMillis,
      }
      modern.add(input.sessionID)
      yield* store(db, parts, PromptSystemTable, systemHash, systemValue, input.system)
      yield* store(db, tools, PromptToolsTable, toolsHash, toolsValue, input.definitions)
      yield* db
        .insert(PromptStartTable)
        .values({ session_id: input.sessionID, ...values })
        .onConflictDoUpdate({ target: PromptStartTable.session_id, set: values })
        .run()
        .pipe(Effect.orDie)
      return { parts: systemHash, tools: toolsHash }
    })

    // Untraced: it runs on every request, and its span would cost more than its work on a warm step.
    const resolve = Effect.fnUntraced(function* (input: Input) {
      const now: Start = { system: input.system, definitions: input.definitions }
      if (Option.isNone(database) || input.kind === "title") return now
      const db = database.value.db
      const row = yield* read(db, input.sessionID)
      // A chat that isn't stored has nothing to keep its record with.
      if (!row) return now
      if (input.now !== undefined) {
        // The step of a `legacy` record sends 0.0.50's start and records it; the reminder tells what differs now.
        if (input.kind !== "primary") return now
        const hashes = yield* record(db, input, row.latest)
        const recorded = { ...row, ...hashes, toldParts: hashes.parts, toldTools: hashes.tools }
        const told = yield* remind(db, { ...input, ...input.now }, recorded, now)
        return told ? { ...now, reminder: told } : now
      }
      // A record from before the system parts were recorded holds no start as sent: the chat's next step records one.
      const kept = row.tools === null || row.parts === null ? undefined : row
      if (!(yield* enabled(input.model.providerID))) {
        if (row.tools !== null && input.kind === "primary") yield* forget(db, input.sessionID)
        return now
      }
      if (input.kind !== "primary") {
        const recorded = kept?.agent === input.agent ? yield* recall(db, kept) : undefined
        return recorded ?? now
      }
      const recorded = kept && (yield* warm(input, kept)) ? yield* recall(db, kept) : undefined
      if (kept && recorded) {
        const told = yield* remind(db, input, kept, recorded)
        return told ? { ...recorded, reminder: told } : recorded
      }
      yield* record(db, input, row.latest)
      return now
    })

    const recorded = Effect.fnUntraced(function* (input: Chat) {
      if (Option.isNone(database)) return undefined
      const db = database.value.db
      const row = yield* read(db, input.sessionID)
      if (!row || row.tools === null || row.parts === null || !(yield* enabled(input.model.providerID)))
        return undefined
      if (!(yield* warm(input, row))) return undefined
      return yield* definitionsOf(db, row.tools)
    })

    const legacy = Effect.fnUntraced(function* (input: Chat & Pick<Input, "kind">) {
      if (Option.isNone(database) || input.kind === "title" || modern.has(input.sessionID)) return undefined
      const db = database.value.db
      const row = yield* read(db, input.sessionID)
      if (!row) return undefined
      if (row.tools === null || row.parts !== null) {
        modern.add(input.sessionID)
        return undefined
      }
      if (!(yield* enabled(input.model.providerID))) return undefined
      const holds = input.kind === "primary" ? yield* warm(input, row) : row.agent === input.agent
      if (!holds) return undefined
      const definitions = yield* definitionsOf(db, row.tools)
      return definitions && ({ system: row.system ?? undefined, definitions } satisfies Legacy)
    })

    const refused = (sessionID: SessionSchema.ID) =>
      Option.isNone(database) ? Effect.void : forget(database.value.db, sessionID)

    return Service.of({ resolve, recorded, legacy, refused })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Config.node, PacerModels.node, PacerWarmth.node, Bus.node],
})

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
      parts: PromptStartTable.parts,
      tools: PromptStartTable.tools,
      // A `legacy` record's agent prompt.
      system: PromptStartTable.system,
      toldParts: PromptStartTable.told_parts,
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

/** The list by its hash: held, or read and decoded once; undefined when it can't be read. */
function heldOrRead<A>(
  db: Db,
  held: Held<A>,
  table: typeof PromptToolsTable | typeof PromptSystemTable,
  decode: (value: string) => Option.Option<ReadonlyArray<A>>,
  hash: string,
): Effect.Effect<ReadonlyArray<A> | undefined> {
  const found = held.get(hash)
  if (found) {
    hold(held, hash, found)
    return Effect.succeed(found)
  }
  return db
    .select({ value: table.value })
    .from(table)
    .where(eq(table.hash, hash))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((stored) => {
        const decoded = stored && Option.getOrUndefined(decode(stored.value))
        if (decoded) hold(held, hash, decoded)
        return decoded
      }),
    )
}

const store = <A>(
  db: Db,
  held: Held<A>,
  table: typeof PromptToolsTable | typeof PromptSystemTable,
  hash: string,
  value: string,
  list: ReadonlyArray<A>,
) => {
  hold(held, hash, list)
  return db.insert(table).values({ hash, value }).onConflictDoNothing().run().pipe(Effect.orDie)
}

const forget = (db: Db, sessionID: SessionSchema.ID) =>
  db.delete(PromptStartTable).where(eq(PromptStartTable.session_id, sessionID)).run().pipe(Effect.orDie, Effect.asVoid)

const HEADER =
  "While this chat's prompt cache is warm, its system prompt and tool list stay as they were sent; these changes apply from now on, and come into them at its next cold point:"

/**
 * The reminder's text: each system part that changed as a diff of the passages that changed, or its whole new text
 * when that is shorter, each that came and each that went; each tool whose description or input changed, with both;
 * each that went; each that comes. Undefined when none of that changed (only the tools' order, say).
 */
export function reminder(input: {
  readonly before: ReadonlyArray<SystemPart>
  readonly after: ReadonlyArray<SystemPart>
  /** Whether the first part is the agent's prompt. */
  readonly prompt: boolean
  readonly told: ReadonlyArray<ToolDefinition>
  readonly now: ReadonlyArray<ToolDefinition>
}) {
  const tools = Instructions.diffByKey(
    input.told,
    input.now,
    (tool) => tool.name,
    (previous, current) =>
      previous.description !== current.description ||
      JSON.stringify(previous.inputSchema) !== JSON.stringify(current.inputSchema),
  )
  const parts = [
    ...systemChanges(input.before, input.after, input.prompt),
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
  return [HEADER, ...parts].join("\n\n")
}

/**
 * What changed in the system parts, matched by their texts: a part replaced where it stood changed, and is shown as
 * the diff or its whole new text, whichever is shorter; one only added came; one only removed went. Each is named by
 * its place, the first the agent's prompt when it is one.
 */
function systemChanges(before: ReadonlyArray<SystemPart>, after: ReadonlyArray<SystemPart>, prompt: boolean) {
  const label = (index: number) =>
    index === 0 && prompt ? "The agent's prompt" : `Part ${index + 1} of the system prompt`
  const changes = diffArrays(
    before.map((part) => part.text),
    after.map((part) => part.text),
  )
  const texts: string[] = []
  const at = { before: 0, after: 0 }
  changes.forEach((change, index) => {
    const previous = changes[index - 1]
    if (!change.added && !change.removed) {
      at.before += change.value.length
      at.after += change.value.length
      return
    }
    // A removal followed by an addition is a replacement: paired one by one, read with the removal.
    if (change.added && previous?.removed) return
    const removed = change.removed ? change.value : []
    const next = changes[index + 1]
    const added = change.added ? change.value : next?.added ? next.value : []
    removed.forEach((text, offset) =>
      texts.push(
        offset < added.length
          ? changed(label(at.after + offset), text, added[offset]!)
          : `${label(at.before + offset)} no longer applies. It was:\n${text}`,
      ),
    )
    added
      .slice(removed.length)
      .forEach((text, offset) =>
        texts.push(`${label(at.after + removed.length + offset)} is new, and applies from now on:\n${text}`),
      )
    at.before += removed.length
    at.after += added.length
  })
  return texts
}

function changed(label: string, before: string, after: string) {
  const patch = createPatch("prompt", before, after, "", "", { context: 3 })
  const diff = [
    `${label} changed; the new passages apply from now on. Here's the diff:`,
    "```diff",
    patch.slice(patch.indexOf("@@")).trimEnd(),
    "```",
  ].join("\n")
  const whole = `${label} changed; from now on it is:\n${after}`
  return diff.length < whole.length ? diff : whole
}

/** Whether two lists hold the same objects in the same order. */
function sameObjects<A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/** Whether two lists read the same, item by item (`equal`). */
function equalList(left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>) {
  return left.length === right.length && left.every((item, index) => equal(item, right[index]))
}

/**
 * Whether two JSON values are equal: by identity first, then field by field with their keys in the same order, so
 * that equal values serialise the same. Nothing is serialised.
 */
export function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && Array.isArray(right)) return equalList(left, right)
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
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

function hold<A>(held: Held<A>, hash: string, list: ReadonlyArray<A>) {
  held.delete(hash)
  held.set(hash, list)
  if (held.size > HELD) held.delete(held.keys().next().value!)
}

function ttl(value: string | undefined) {
  const match = value === undefined ? null : /^(\d+)(ms|s|m|h|d)$/.exec(value)
  if (!match) return CACHE_TTL
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "ms" | "s" | "m" | "h" | "d"]
  return Number(match[1]) * unit
}
