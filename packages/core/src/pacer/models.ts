export * as PacerModels from "./models.js"

import { Clock, Context, Effect, Layer, Option, Result, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { PacerEndpoint } from "./endpoint.js"
import { PacerHttp } from "./http.js"

// The seam between the CLIProxyPacer provider and the service's connection to CPP. The provider's side builds the
// catalog and owns every read of `/v1/models`, `/pacer/v1/capabilities` and `/pacer/v1/models`; the connection asks
// it to read again when CPP's change stream says so (`capabilities`, `settings`, `price`, `resync`, a reconnect) and
// takes "no pacer" from it. Fields may be added; none may be removed or renamed without both sides.

/** What capabilities' `pacer` block says the server does; null for a proxy without the pacer. */
export interface Pacer {
  /** `pacer.compact_tokens`: the `X-Pacer-Compact` tokens the server reads. */
  readonly compactTokens: ReadonlyArray<string>
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
  /** The rates of the `fast` or `priority` service tier, where it differs. */
  readonly fast?: Rates
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
  /** Capabilities' `remote_compaction` and `in_request_compaction`; `mixed` where routes disagree. */
  readonly remoteCompaction?: string
  readonly inRequestCompaction?: string
  /** Undefined when CPP has no price for it; `/pacer/v1/models` prices only the models used in the last 30 days. */
  readonly price?: Price
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
  remote_compaction: maybe(Schema.String),
  in_request_compaction: maybe(Schema.String),
  routes: Items,
})
const CapabilitiesAnswer = Schema.Struct({
  pacer: Schema.NullOr(Schema.Struct({ compact_tokens: maybe(Schema.Array(Schema.String)) })),
  models: Items,
})

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
      fast: maybe(RatesAnswer),
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
const decodePriced = Schema.decodeUnknownOption(Priced)
const decodeManual = Schema.decodeUnknownOption(Manual)
const decodeSetting = Schema.decodeUnknownOption(Setting)

const each = <A>(items: ReadonlyArray<unknown> | null | undefined, decode: (item: unknown) => Option.Option<A>) =>
  (items ?? []).flatMap((item) => Option.toArray(decode(item)))

type Capability = typeof Capable.Type & { readonly routes: ReadonlyArray<Route> }

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
      const [list, capabilities, priced] = yield* Effect.all(
        [
          http.get("/v1/models", ListAnswer, options),
          // A refusal, a 404 or an answer that is not CPP's is a plain proxy; only an unreachable one fails the read.
          http.get("/pacer/v1/capabilities", CapabilitiesAnswer, options).pipe(
            Effect.map((answer) => answer.body),
            Effect.catchIf(definite, () => Effect.succeed(undefined)),
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
        pacer && { compactTokens: pacer.compact_tokens ?? [] },
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

    yield* endpoints.changes().pipe(Stream.runForEach(refresh), Effect.forkScoped({ startImmediately: true }))

    return Service.of({
      get: () => SubscriptionRef.get(current),
      changes: () => SubscriptionRef.changes(current),
      refresh: () => refresh(),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [PacerEndpoint.node, PacerHttp.node] })

/** An answer that will not change on its own: anything but an unreachable server. */
function definite(error: PacerHttp.Error) {
  return error._tag !== "PacerHttp.Unreachable"
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
  pacer: Pacer | null,
  prices: Prices | undefined,
): Catalog {
  const seen = new Set<string>()
  const models = listed.flatMap((item) => {
    if (seen.has(item.id)) return []
    seen.add(item.id)
    return [model(item, capabilities, prices)]
  })
  return { at, pacer, models }
}

function model(
  listed: typeof Listed.Type,
  capabilities: ReadonlyMap<string, Capability>,
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
  const remoteCompaction = text((exact ?? base)?.remote_compaction)
  const inRequestCompaction = text((exact ?? base)?.in_request_compaction)
  const context = facts.context ?? positive(listed.context_length)
  const maxOutput = facts.maxOutput ?? positive(setting?.max_output) ?? positive(listed.max_completion_tokens)
  const price = prices && lookup(prices, lower, pinned, routes[0]?.provider.toLowerCase())
  return {
    id,
    ...(text(listed.owned_by) ? { ownedBy: text(listed.owned_by) } : {}),
    ...(name ? { name } : {}),
    ...(context ? { context } : {}),
    ...(maxOutput ? { maxOutput } : {}),
    ...(facts.input ? { input: facts.input } : {}),
    ...(facts.output ? { output: facts.output } : {}),
    ...(facts.reasoning ? { reasoning: facts.reasoning } : {}),
    ...(remoteCompaction ? { remoteCompaction } : {}),
    ...(inRequestCompaction ? { inRequestCompaction } : {}),
    ...(price ? { price } : {}),
  }
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
  const same = (item: { readonly provider: string; readonly model: string }, model: string) =>
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
      ...(found.price.fast ? { fast: rates(found.price.fast) } : {}),
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
