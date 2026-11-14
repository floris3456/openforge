export * as PacerModels from "./models.js"

import { Clock, Context, Effect, Layer, Option, Result, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import type { Pacer as Shapes } from "@opencode/schema/pacer"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { PacerEndpoint } from "./endpoint.js"
import { PacerHttp } from "./http.js"

// The seam between the CLIProxyPacer provider and the service's connection to CPP. The provider's side builds the
// catalog and owns every read of `/v1/models`, `/pacer/v1/capabilities` and `/pacer/v1/models`; the connection asks
// it to read again when CPP's change stream says so (`capabilities`, `price`, `resync`, a reconnect; a `settings`
// notice reads no catalog), and so does the `pacer.refresh` route as the model picker opens. In "no pacer" the
// connection waits for a read that finds the pacer. Fields may be added; none may be removed or renamed without both
// sides.

/** What capabilities' `pacer` block says the server does; null for a proxy without the pacer. */
export interface Pacer {
  /** `pacer.compact_tokens`: the `X-Pacer-Compact` tokens the server reads. */
  readonly compactTokens: ReadonlyArray<string>
  /** Whether the server has the web tools: `pacer.web_tools` names their list's path (`tools`). */
  readonly webTools: boolean
  /** `pacer.memory`, when the server has memory in a version this one reads; absent otherwise. */
  readonly memory?: Memory
  /**
   * `pacer.freeze_prompt` for the asking key: false when it lets a warm chat's prompt follow every change at its next
   * step (`SessionPromptStart`). A server without the field: true.
   */
  readonly freezePrompt?: boolean
}

/** The limits of the server's memory store (the memory API's capabilities). */
export interface Memory {
  readonly version: 1
  readonly entryCharacters: number
  readonly queryCharacters: number
  readonly searchLimit: number
  /** The embedding model the server asks for vectors; null when it searches by word only. */
  readonly embedding: string | null
  /** Whether the server has tasks (the memory API's section "Tasks"). */
  readonly tasks: boolean
  /** Whether the server keeps the recall log, to which openforge adds what followed a search. */
  readonly recalls: boolean
  /**
   * Whether the server keeps memory per project, each switched on or off on its Projects page (workspace spec
   * `docs/specs/cpp-projects.md`). Nothing reads it yet.
   */
  readonly projects: boolean
  /**
   * Whether the server answers each prompt's close entries (`POST …/prompt`, the memory API's section "Prompt"); a
   * start then asks for no entries.
   */
  readonly prompt: boolean
}

/** USD per million tokens; undefined where CPP has no rate, which it counts as unpriced. */
export interface Rates {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** The price CPP counts a model's requests at (`/pacer/v1/models`). */
export interface Price {
  readonly rates: Rates
  /** For a request whose input is above `above` tokens, the rates it sets replace `rates`'. */
  readonly context: ReadonlyArray<{ readonly above: number; readonly rates: Rates }>
}

/** Thinking controls every route of the model accepts. */
export interface Reasoning {
  /** Effort levels, in CPP's order; undefined for budget-only thinking. */
  readonly levels?: ReadonlyArray<string>
  /** Thinking budget bounds in tokens. */
  readonly min?: number
  readonly max?: number
  /** Whether thinking can be turned off. */
  readonly zeroAllowed: boolean
}

export interface Model {
  /** CPP's model ID, as `/v1/models` lists it. */
  readonly id: string
  /** `/v1/models`' `owned_by`. */
  readonly ownedBy?: string
  readonly name?: string
  /**
   * The facts below come from capabilities' routes (one per kind of account that serves the model), so they hold
   * whichever account CPP picks: the smallest window and output limit, the input modalities every route takes and
   * the output modalities any produces. Undefined where no route says; all are for a plain proxy.
   */
  readonly context?: number
  readonly maxOutput?: number
  readonly input?: ReadonlyArray<string>
  readonly output?: ReadonlyArray<string>
  readonly reasoning?: Reasoning
  /** Undefined when CPP has no price for it; `/pacer/v1/models` prices only the models used in the last 30 days. */
  readonly price?: Price
  /**
   * Per route, by the provider of the accounts it stands for: whether CPP writes a summary of the model itself for a
   * chat whose `compaction.writer` is `server` ({@link routeWrites}). Undefined while no route says (a plain proxy, or
   * a CPP before `remote_compaction`).
   */
  readonly summaries?: ReadonlyArray<{ readonly provider: string; readonly writes: boolean }>
  /**
   * The providers whose accounts serve it, in lower case, once each, in capabilities' order, API keys included: they
   * have meters too (the sidebar's usage meters, spec cliproxypacer-usage-meters). Undefined where no route says (a
   * plain proxy).
   */
  readonly providers?: ReadonlyArray<string>
  /**
   * Of `providers`, those only some of whose accounts serve it: a login of the provider without a route of the model,
   * or with a route counting fewer of its accounts (capabilities' `providers[]` against `routes[].accounts`). Which
   * of them do, CPP doesn't say. Undefined when none.
   */
  readonly partial?: ReadonlyArray<string>
}

/** CPP's models as last read. */
export interface Catalog {
  /** When it was read, on the local clock (Unix ms). */
  readonly at: number
  /** Null when the proxy has no pacer: capabilities answered 404, was refused, or said `pacer: null`. */
  readonly pacer: Pacer | null
  readonly models: ReadonlyArray<Model>
}

export interface Interface {
  /** The catalog as last read; undefined while CPP is not set up or before the first read succeeded. */
  readonly get: () => Effect.Effect<Catalog | undefined>
  /** The catalog now, then each change of it. */
  readonly changes: () => Stream.Stream<Catalog | undefined>
  /** Reads everything again now. A failed read keeps the last catalog. */
  readonly refresh: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerModels") {}

// CPP leaves out or nulls what it does not know. Each list entry is decoded on its own, so one this version does not
// understand drops only itself.
const maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))
const Items = maybe(Schema.Array(Schema.Unknown))

const Listed = Schema.Struct({
  id: Schema.String,
  owned_by: maybe(Schema.String),
  // Set on a model the owner customized.
  display_name: maybe(Schema.String),
  context_length: maybe(Schema.Number),
  max_completion_tokens: maybe(Schema.Number),
})
const ListAnswer = Schema.Struct({ data: Schema.Array(Schema.Unknown) })

const Thinking = Schema.Struct({
  levels: maybe(Schema.Array(Schema.String)),
  min: maybe(Schema.Number),
  max: maybe(Schema.Number),
  zero_allowed: maybe(Schema.Boolean),
})
const Route = Schema.Struct({
  provider: Schema.String,
  /** The kind of login: `oauth` or `api_key`. */
  login: maybe(Schema.String),
  /** How many of the provider's accounts of that login serve the model. */
  accounts: maybe(Schema.Number),
  /** How `/v1/responses/compact` is served for the key: `native`, `forwarded`, `emulated` or `unsupported`. */
  remote_compaction: maybe(Schema.String),
  /** Whether CPP writes the route's summary itself for a chat whose `compaction.writer` is `server`. */
  server_writes: maybe(Schema.Boolean),
  context_length: maybe(Schema.Number),
  max_output: maybe(Schema.Number),
  input: maybe(Schema.Array(Schema.String)),
  output: maybe(Schema.Array(Schema.String)),
  reasoning: maybe(Thinking),
})
type Route = typeof Route.Type
const Capable = Schema.Struct({
  id: Schema.String,
  display_name: maybe(Schema.String),
  routes: Items,
})
/** One kind of login of a provider, with how many accounts the key has of it (capabilities' `providers[]`). */
const Login = Schema.Struct({ provider: Schema.String, login: maybe(Schema.String), accounts: maybe(Schema.Number) })
type Login = typeof Login.Type
// `web_tools` and `memory` are read on their own (`webTools`, `memory`, in `pacerOf`), so a block this version does not
// understand leaves the rest alone.
export const CapabilitiesAnswer = Schema.Struct({
  pacer: Schema.NullOr(
    Schema.Struct({
      compact_tokens: maybe(Schema.Array(Schema.String)),
      web_tools: Schema.optional(Schema.Unknown),
      memory: Schema.optional(Schema.Unknown),
      freeze_prompt: Schema.optional(Schema.Unknown),
    }),
  ),
  providers: Items,
  models: Items,
})
const WebTools = Schema.Struct({ tools: Schema.String })
const decodeWebTools = Schema.decodeUnknownOption(WebTools)
const Limit = Schema.Int.check(Schema.isGreaterThan(0))
const MemoryBlock = Schema.Struct({
  version: Schema.Literal(1),
  entry_characters: Limit,
  query_characters: Limit,
  search_limit: Limit,
  embedding: Schema.NullOr(Schema.String),
  tasks: Schema.optional(Schema.Unknown),
  recalls: Schema.optional(Schema.Unknown),
  projects: Schema.optional(Schema.Unknown),
  prompt: Schema.optional(Schema.Unknown),
})
const decodeMemory = Schema.decodeUnknownOption(MemoryBlock)

const RatesAnswer = Schema.Struct({
  input: maybe(Schema.Number),
  output: maybe(Schema.Number),
  cache_read: maybe(Schema.Number),
  cache_write: maybe(Schema.Number),
})
type RatesAnswer = typeof RatesAnswer.Type
const Priced = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  price: maybe(
    Schema.Struct({
      rates: RatesAnswer,
      context: maybe(Schema.Array(Schema.Struct({ above: Schema.Number, rates: RatesAnswer }))),
    }),
  ),
})
const Manual = Schema.Struct({
  model: Schema.String,
  input: Schema.Number,
  output: Schema.Number,
  cache_read: maybe(Schema.Number),
  cache_write: maybe(Schema.Number),
})
const Setting = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  display_name: maybe(Schema.String),
  max_output: maybe(Schema.Number),
})
const PricesAnswer = Schema.Struct({ models: Items, manual: Items, settings: Items })

const decodeListed = Schema.decodeUnknownOption(Listed)
const decodeCapable = Schema.decodeUnknownOption(Capable)
const decodeRoute = Schema.decodeUnknownOption(Route)
const decodeLogin = Schema.decodeUnknownOption(Login)
const decodePriced = Schema.decodeUnknownOption(Priced)
const decodeManual = Schema.decodeUnknownOption(Manual)
const decodeSetting = Schema.decodeUnknownOption(Setting)

const each = <A>(items: ReadonlyArray<unknown> | null | undefined, decode: (item: unknown) => Option.Option<A>) =>
  (items ?? []).flatMap((item) => Option.toArray(decode(item)))

type Capability = Omit<typeof Capable.Type, "routes"> & { readonly routes: ReadonlyArray<Route> }

/** What `/pacer/v1/models` says, decoded. */
interface Prices {
  readonly models: ReadonlyArray<typeof Priced.Type>
  readonly manual: ReadonlyArray<typeof Manual.Type>
  readonly settings: ReadonlyArray<typeof Setting.Type>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const endpoints = yield* PacerEndpoint.Service
    const current = yield* SubscriptionRef.make<Catalog | undefined>(undefined)
    const lock = Semaphore.makeUnsafe(1)
    // The address the catalog belongs to, and the last prices read from it: a passing failure of the optional price
    // read keeps them rather than pricing every request at nothing.
    let root: string | undefined
    let prices: Prices | undefined

    const read = Effect.fn("PacerModels.read")(function* (endpoint: PacerEndpoint.Endpoint) {
      const options = { endpoint }
      // A first read takes an answer it can't use for a plain proxy, as one that serves a page at every path; once a
      // catalog is held, such an answer (a 429, a redirect, a body that does not decode) keeps it instead.
      const held = (yield* SubscriptionRef.get(current)) !== undefined
      const [list, capabilities, priced] = yield* Effect.all(
        [
          http.get("/v1/models", ListAnswer, options),
          // A refusal or a 404 is a plain proxy; an unreachable server or another answer fails the read.
          http.get("/pacer/v1/capabilities", CapabilitiesAnswer, options).pipe(
            Effect.map((answer) => answer.body),
            Effect.catchIf(
              (error) => definite(error) || (!held && error._tag === "PacerHttp.Unexpected"),
              () => Effect.succeed(undefined),
            ),
          ),
          http.get("/pacer/v1/models", PricesAnswer, options).pipe(
            Effect.map((answer): Prices | undefined => ({
              models: each(answer.body.models, decodePriced),
              manual: each(answer.body.manual, decodeManual),
              settings: each(answer.body.settings, decodeSetting),
            })),
            Effect.catchIf(definite, () => Effect.succeed(undefined)),
            Effect.orElseSucceed(() => prices),
          ),
        ],
        { concurrency: "unbounded" },
      )
      const pacer = capabilities?.pacer ?? null
      prices = pacer ? priced : undefined
      return build(
        yield* Clock.currentTimeMillis,
        each(list.body.data, decodeListed),
        pacer ? capable(capabilities?.models) : new Map(),
        pacer ? each(capabilities?.providers, decodeLogin) : [],
        pacer && pacerOf(pacer),
        prices,
      )
    })

    const refresh = Effect.fn("PacerModels.refresh")(
      function* () {
        const endpoint = yield* endpoints.get()
        // Another address's models are not this one's, not even while its first read is under way.
        if (endpoint?.root !== root) {
          root = endpoint?.root
          prices = undefined
          if (yield* SubscriptionRef.get(current)) yield* SubscriptionRef.set(current, undefined)
        }
        if (!endpoint) return
        const result = yield* read(endpoint).pipe(Effect.result)
        // The endpoint changed during the read; the change starts a read of its own.
        if (!PacerEndpoint.same(endpoint, yield* endpoints.get())) return
        if (Result.isFailure(result))
          return yield* Effect.logWarning("could not read CLIProxyPacer's models", { reason: result.failure.message })
        yield* SubscriptionRef.set(current, result.success)
      },
      (effect) => lock.withPermit(effect),
    )

    // A new endpoint interrupts a read of the old one, which could otherwise hold the lock until its timeout.
    yield* endpoints.changes().pipe(
      Stream.switchMap(() => Stream.fromEffect(refresh())),
      Stream.runDrain,
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({
      get: () => SubscriptionRef.get(current),
      changes: () => SubscriptionRef.changes(current),
      refresh: () => refresh(),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [PacerEndpoint.node, PacerHttp.node] })

/** What capabilities' `pacer` block says the server does, each part read on its own. */
export function pacerOf(pacer: NonNullable<typeof CapabilitiesAnswer.Type.pacer>): Pacer {
  return {
    compactTokens: pacer.compact_tokens ?? [],
    webTools: Option.isSome(decodeWebTools(pacer.web_tools)),
    freezePrompt: pacer.freeze_prompt !== false,
    ...Option.match(decodeMemory(pacer.memory), {
      onNone: () => ({}),
      onSome: (memory) => ({
        memory: {
          version: memory.version,
          entryCharacters: memory.entry_characters,
          queryCharacters: memory.query_characters,
          searchLimit: memory.search_limit,
          embedding: memory.embedding,
          tasks: memory.tasks === true,
          recalls: memory.recalls === true,
          projects: memory.projects === true,
          prompt: memory.prompt === true,
        },
      }),
    }),
  }
}

/** An answer that will not change on its own: a 404, a refused key. Not an unreachable server, a 429 or a redirect. */
function definite(error: PacerHttp.Error) {
  return error._tag !== "PacerHttp.Unreachable" && error._tag !== "PacerHttp.Unexpected"
}

function capable(items: ReadonlyArray<unknown> | null | undefined) {
  return new Map(
    each(items, decodeCapable).map((model): [string, Capability] => [
      model.id.toLowerCase(),
      { ...model, routes: each(model.routes, decodeRoute) },
    ]),
  )
}

function build(
  at: number,
  listed: ReadonlyArray<typeof Listed.Type>,
  capabilities: ReadonlyMap<string, Capability>,
  logins: ReadonlyArray<Login>,
  pacer: Pacer | null,
  prices: Prices | undefined,
): Catalog {
  const seen = new Set<string>()
  const models = listed.flatMap((item) => {
    if (seen.has(item.id)) return []
    seen.add(item.id)
    return [model(item, capabilities, logins, prices)]
  })
  return { at, pacer, models }
}

function model(
  listed: typeof Listed.Type,
  capabilities: ReadonlyMap<string, Capability>,
  logins: ReadonlyArray<Login>,
  prices: Prices | undefined,
): Model {
  const id = listed.id
  const lower = id.toLowerCase()
  const exact = capabilities.get(lower)
  // A model more than one provider serves is also listed as `<provider>/<model>`, which pins that provider.
  const slash = lower.indexOf("/")
  const pinned = exact || slash <= 0 ? undefined : { provider: lower.slice(0, slash), model: lower.slice(slash + 1) }
  const base = pinned && capabilities.get(pinned.model)
  const own = base?.routes.filter((route) => route.provider.toLowerCase() === pinned?.provider)
  const routes = exact?.routes ?? (own?.length ? own : base?.routes) ?? []
  const setting = prices?.settings.find((item) => item.model.toLowerCase() === lower)
  const facts = merge(routes)
  const name =
    text(exact?.display_name) ??
    (base && pinned && text(base.display_name) && `${base.display_name} (${pinned.provider})`) ??
    text(setting?.display_name) ??
    text(listed.display_name)
  const context = facts.context ?? positive(listed.context_length)
  const maxOutput = facts.maxOutput ?? positive(setting?.max_output) ?? positive(listed.max_completion_tokens)
  const price = prices && lookup(prices, lower, pinned, routes[0]?.provider.toLowerCase())
  const summaries = routes.some(
    (route) => typeof route.server_writes === "boolean" || typeof route.remote_compaction === "string",
  )
    ? routes.map((route) => ({ provider: route.provider, writes: routeWrites(route) }))
    : undefined
  const providers = Array.from(new Set(routes.map((route) => route.provider.toLowerCase())))
  const partial = providers.filter((provider) => !servesAll(provider, routes, logins))
  return {
    id,
    ...(text(listed.owned_by) ? { ownedBy: text(listed.owned_by) } : {}),
    ...(name ? { name } : {}),
    ...(context ? { context } : {}),
    ...(maxOutput ? { maxOutput } : {}),
    ...(facts.input ? { input: facts.input } : {}),
    ...(facts.output ? { output: facts.output } : {}),
    ...(facts.reasoning ? { reasoning: facts.reasoning } : {}),
    ...(price ? { price } : {}),
    ...(summaries ? { summaries } : {}),
    ...(providers.length > 0 ? { providers } : {}),
    ...(partial.length > 0 ? { partial } : {}),
  }
}

/**
 * Whether every account of `provider` serves a model of these routes: each of its logins has a route of the model
 * counting all its accounts. What CPP doesn't count (an older CPP) counts as all.
 */
function servesAll(provider: string, routes: ReadonlyArray<Route>, logins: ReadonlyArray<Login>) {
  return logins
    .filter((login) => login.provider.toLowerCase() === provider)
    .every((login) =>
      routes.some(
        (route) =>
          route.provider.toLowerCase() === provider &&
          (route.login ?? undefined) === (login.login ?? undefined) &&
          (route.accounts == null || login.accounts == null || route.accounts >= login.accounts),
      ),
    )
}

/** The catalog's models by the providers serving them, in the service API's shape; undefined without the pacer. */
export function served(catalog: Catalog | undefined): Shapes.Models | undefined {
  if (!catalog?.pacer) return undefined
  return {
    items: catalog.models.map((model) => ({
      id: model.id,
      providers: [...(model.providers ?? [])],
      ...(model.partial ? { partial: [...model.partial] } : {}),
    })),
  }
}

/**
 * Whether CPP writes a summary of a route's model itself for a chat whose `compaction.writer` is `server`: the route's
 * `server_writes` (`cpa_exec::capability::server_writes`, CPP from c1ac59ed, 2026-11-10), whatever the key's own
 * writer; it may say `true` beside `unsupported`, as for a CommandCode API key's chat models. A route without it (an
 * older CPP) is written only where it says `emulated`, which CPP always writes.
 */
function routeWrites(route: Route) {
  return route.server_writes ?? route.remote_compaction === "emulated"
}

/**
 * Whether CPP writes `model`'s summaries for a chat whose `compaction.writer` is `server`: on the routes of `provider`,
 * the chat's account's, when it has any, else on every route, since CPP may pick any of them. False while nothing is
 * known.
 */
export function writes(model: Pick<Model, "summaries"> | undefined, provider?: string) {
  const routes = model?.summaries ?? []
  const own = provider ? routes.filter((route) => route.provider.toLowerCase() === provider.toLowerCase()) : []
  const chosen = own.length > 0 ? own : routes
  return chosen.length > 0 && chosen.every((route) => route.writes)
}

function merge(routes: ReadonlyArray<Route>) {
  const known = <A>(pick: (route: Route) => A | null | undefined) =>
    routes.flatMap((route) => {
      const value = pick(route)
      return value === null || value === undefined ? [] : [value]
    })
  const least = (values: ReadonlyArray<number>) => (values.length > 0 ? Math.min(...values) : undefined)
  const inputs = known((route) => route.input).map(modalities)
  const outputs = known((route) => route.output).map(modalities)
  return {
    context: least(known((route) => positive(route.context_length))),
    maxOutput: least(known((route) => positive(route.max_output))),
    input: inputs[0]?.filter((item) => inputs.every((list) => list.includes(item))),
    output: outputs.length > 0 ? Array.from(new Set(outputs.flat())) : undefined,
    reasoning: reasoning(known((route) => route.reasoning)),
  }
}

function reasoning(stated: ReadonlyArray<typeof Thinking.Type>): Reasoning | undefined {
  if (stated.length === 0) return undefined
  const leveled = stated.flatMap((item) => (item.levels?.length ? [item.levels] : []))
  const levels = leveled[0]?.filter((level) => leveled.every((list) => list.includes(level)))
  const budgets = stated.filter((item) => positive(item.min) || positive(item.max))
  const min = budgets.length > 0 ? Math.max(...budgets.map((item) => positive(item.min) ?? 0)) : undefined
  const max = budgets.length > 0 ? Math.min(...budgets.map((item) => positive(item.max) ?? Infinity)) : undefined
  const bounded = min !== undefined && max !== undefined && min <= max
  return {
    ...(levels?.length ? { levels } : {}),
    ...(bounded && min > 0 ? { min } : {}),
    ...(bounded && Number.isFinite(max) ? { max } : {}),
    zeroAllowed: stated.every((item) => item.zero_allowed === true),
  }
}

/**
 * CPP prices a request by provider and model. A model several providers serve is priced by the one capabilities
 * lists first; a manual price, which CPP gives by model alone, prices a model nothing has used yet.
 */
function lookup(
  prices: Prices,
  lower: string,
  pinned: { readonly provider: string; readonly model: string } | undefined,
  provider: string | undefined,
): Price | undefined {
  const same = (item: typeof Priced.Type, model: string) =>
    item.model.toLowerCase() === model && item.price !== null && item.price !== undefined
  const candidates = prices.models.filter((item) => same(item, lower))
  const found =
    candidates.find((item) => item.provider.toLowerCase() === provider) ??
    candidates[0] ??
    (pinned &&
      prices.models.find((item) => item.provider.toLowerCase() === pinned.provider && same(item, pinned.model)))
  if (found?.price)
    return {
      rates: rates(found.price.rates),
      context: (found.price.context ?? [])
        .map((tier) => ({ above: tier.above, rates: rates(tier.rates) }))
        .toSorted((a, b) => a.above - b.above),
    }
  const manual = prices.manual.find((item) => [lower, pinned?.model].includes(item.model.toLowerCase()))
  return manual && { rates: rates(manual), context: [] }
}

function rates(input: RatesAnswer): Rates {
  const rate = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
  const result = {
    input: rate(input.input),
    output: rate(input.output),
    cacheRead: rate(input.cache_read),
    cacheWrite: rate(input.cache_write),
  }
  return Object.fromEntries(Object.entries(result).filter((entry) => entry[1] !== undefined))
}

function modalities(list: ReadonlyArray<string>) {
  return list.map((item) => item.trim().toLowerCase()).filter((item) => item !== "")
}

function positive(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function text(value: string | null | undefined) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}
