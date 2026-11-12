import { Effect, Option, Stream } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Form } from "@opencode/schema/form"
import { Money } from "@opencode/schema/money"
import { Model } from "../../model.js"
import { PacerEndpoint } from "../../pacer/endpoint.js"
import { PacerModels } from "../../pacer/models.js"
import { Provider } from "../../provider.js"
import { Variant } from "../../variant.js"
import type { PluginInternal } from "../internal.js"

export const providerID = Provider.ID.make(PacerEndpoint.id)
const name = "CLIProxyPacer"
// Claude speaks Anthropic Messages, every other model OpenAI Responses; both packages are HTTP only.
const RESPONSES = "@opencode/ai/providers/openai-compatible-responses"
const MESSAGES = "@opencode/ai/providers/anthropic-compatible"
// A model that answers only images goes to CPP's /v1/images/generations and /v1/images/edits (spec image-tools).
const IMAGES = "@opencode/ai/providers/openai-compatible/images"

/**
 * CPP as a built-in provider. Its address and key come from PacerEndpoint alone, which reads global config and the
 * credential store, never a location's config; its models from PacerModels, which is the only reader of CPP's lists.
 */
export const CLIProxyPacerPlugin = define({
  id: "opencode.provider.cliproxypacer",
  effect: Effect.fn(function* (ctx) {
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    // The login form asks for the address unless the config PacerEndpoint reads (global, never a project's) gives
    // one, and follows it; the form's answer is kept as credential metadata.
    const addresses = () => endpoints.configuredAddress?.() ?? Stream.make(false)
    const address = { configured: Option.getOrElse(yield* Stream.runHead(addresses()), () => false) }
    yield* ctx.integration.transform((integrations) => {
      integrations.update(PacerEndpoint.id, (integration) => {
        integration.name = name
      })
      integrations.method.update({
        integrationID: PacerEndpoint.id,
        method: { type: "key", label: "Client key", form: address.configured ? undefined : form },
      })
    })
    yield* addresses().pipe(
      Stream.runForEach((configured) => {
        if (configured === address.configured) return Effect.void
        address.configured = configured
        return ctx.integration.reload()
      }),
      Effect.forkScoped({ startImmediately: true }),
    )

    const current = { endpoint: yield* endpoints.get(), built: models(yield* catalogs.get(), yield* endpoints.get()) }
    yield* ctx.provider.transform((providers) => {
      const endpoint = current.endpoint
      providers.update(providerID, (provider) => {
        provider.name = name
        provider.activation = endpoint ? "enabled" : "auto"
        provider.package = RESPONSES
        provider.integrationID = PacerEndpoint.id
        provider.settings = {
          ...provider.settings,
          ...(endpoint ? { baseURL: endpoint.baseURL } : {}),
          provider: providerID,
        }
      })
      providers.models.set(providerID, current.built.models)
    })
    // Config's provider transform, which runs later, puts its own base URL on the provider and takes it off every
    // model; model settings win, so each model gets CPP's address back here, after every provider transform.
    yield* ctx.model.transform((editor) => {
      const endpoint = current.endpoint
      if (!endpoint) return
      for (const [id, model] of editor.provider.get(providerID)?.models ?? []) {
        const want = pinned(endpoint, model.package === MESSAGES)
        if (Object.entries(want).every(([key, value]) => model.settings?.[key] === value)) continue
        editor.update(providerID, id, (draft) => {
          draft.settings = { ...draft.settings, ...want }
        })
      }
    })

    const update = Effect.fn("CLIProxyPacerPlugin.update")(function* () {
      const endpoint = yield* endpoints.get()
      const built = models(yield* catalogs.get(), endpoint)
      if (PacerEndpoint.same(endpoint, current.endpoint) && built.hash === current.built.hash) return
      current.endpoint = endpoint
      current.built = built
      yield* ctx.provider.reload()
    })
    yield* Stream.merge(endpoints.changes(), catalogs.changes()).pipe(
      Stream.runForEach(update),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

const form = Form.Fields.make([
  {
    type: "string",
    key: "baseURL",
    title: "CLIProxyPacer address",
    placeholder: "https://cliproxy.example.com",
    required: true,
  },
])

/** The settings every model carries: CPP's address, and config's key, which only a credential replaces. */
function pinned(endpoint: PacerEndpoint.Endpoint, claude: boolean): Record<string, string> {
  const base = { baseURL: endpoint.baseURL, provider: providerID }
  if (endpoint.keyFrom === "credential") return base
  // A bearer token, never `x-api-key`: fetch drops Authorization on a redirect to another origin but keeps
  // x-api-key. An empty apiKey is dropped by the resolver, so a configured one can't join the token.
  return claude ? { ...base, apiKey: "", authToken: endpoint.key } : { ...base, apiKey: endpoint.key }
}

// Built once per catalog and endpoint, and shared by every location, which index the same array.
let cache:
  | {
      readonly catalog: PacerModels.Catalog | undefined
      readonly endpoint: PacerEndpoint.Endpoint | undefined
      readonly models: readonly Model.Info[]
      readonly hash: string
    }
  | undefined

function models(catalog: PacerModels.Catalog | undefined, endpoint: PacerEndpoint.Endpoint | undefined) {
  if (cache && cache.catalog === catalog && PacerEndpoint.same(cache.endpoint, endpoint)) return cache
  const list = endpoint && catalog ? catalog.models.flatMap((model) => info(model, endpoint)) : []
  cache = { catalog, endpoint, models: list, hash: JSON.stringify(list) }
  return cache
}

function info(model: PacerModels.Model, endpoint: PacerEndpoint.Endpoint): Model.Info[] {
  if (model.output && !model.output.includes("text"))
    return model.output.includes("image") ? [image(model, endpoint)] : []
  const claude = isClaude(model)
  const id = Model.ID.make(model.id)
  const defaults = Model.Capabilities.default()
  const base: Model.Info = {
    id,
    modelID: id,
    providerID,
    name: model.name ?? model.id,
    ...(claude ? { package: MESSAGES } : {}),
    settings: pinned(endpoint, claude),
    capabilities: {
      tools: true,
      input: model.input ? [...model.input] : defaults.input,
      output: model.output ? [...model.output] : defaults.output,
    },
    variants: [],
    time: { released: 0 },
    cost: cost(model.price),
    status: "active",
    enabled: true,
    limit: { context: model.context ?? 0, output: model.maxOutput ?? 0 },
  }
  return [{ ...base, variants: Variant.resolve({ ...base, package: claude ? MESSAGES : RESPONSES }, supports(model)) }]
}

/** A model CPP says answers images and no text: an image model, offered to image.generate, never as a chat's model. */
function image(model: PacerModels.Model, endpoint: PacerEndpoint.Endpoint): Model.Info {
  const id = Model.ID.make(model.id)
  return {
    id,
    modelID: id,
    providerID,
    type: "image",
    name: model.name ?? model.id,
    package: IMAGES,
    settings: pinned(endpoint, false),
    capabilities: {
      tools: false,
      input: model.input ? [...model.input] : Model.Capabilities.default().input,
      output: [...(model.output ?? [])],
    },
    variants: [],
    time: { released: 0 },
    cost: cost(model.price),
    status: "active",
    enabled: true,
    limit: { context: model.context ?? 0, output: model.maxOutput ?? 0 },
  }
}

/** As CPP and OpenCodePlus tell Claude apart: owned by Anthropic, or the ID's last segment starts with `claude-`. */
export function isClaude(model: Pick<PacerModels.Model, "id" | "ownedBy">) {
  return (
    model.ownedBy?.toLowerCase() === "anthropic" ||
    (model.id.split("/").at(-1) ?? "").toLowerCase().startsWith("claude-")
  )
}

// CPP states thinking per route; where it states nothing, the model gets the variants of any custom provider.
function supports(model: PacerModels.Model): readonly Variant.Support[] | undefined {
  const reasoning = model.reasoning
  if (!reasoning) return undefined
  return [
    ...(reasoning.zeroAllowed ? [{ type: "toggle" as const }] : []),
    ...(reasoning.levels ? [{ type: "effort" as const, values: reasoning.levels }] : []),
    ...(reasoning.min !== undefined || reasoning.max !== undefined
      ? [{ type: "budget_tokens" as const, min: reasoning.min, max: reasoning.max }]
      : []),
  ]
}

const zero = Money.USDPerMillionTokens.zero

/**
 * CPP's price. A model it has none for gets no rows, openforge's unknown price (`Model.Info.default`'s, and what the
 * subscription providers give their models): pickers show no price, and a step costs 0 unless its answer says what it
 * cost. An all-zero row would read as free, and a model on CPP runs on an account.
 */
function cost(price: PacerModels.Price | undefined): Model.Info["cost"] {
  if (price?.rates.input === undefined || price.rates.output === undefined) return []
  const base = row(price.rates, undefined)
  // A tier sets only the rates that change; CPP lays it over the base rates.
  return [
    base,
    ...price.context.map((tier) => ({
      ...row(tier.rates, base),
      tier: { type: "context" as const, size: Math.floor(tier.above) },
    })),
  ]
}

function row(rates: PacerModels.Rates, base: Model.Info["cost"][number] | undefined): Model.Info["cost"][number] {
  const usd = (value: number | undefined, fallback: Money.USDPerMillionTokens | undefined) =>
    value === undefined ? (fallback ?? zero) : Money.USDPerMillionTokens.make(value)
  return {
    input: usd(rates.input, base?.input),
    output: usd(rates.output, base?.output),
    cache: { read: usd(rates.cacheRead, base?.cache.read), write: usd(rates.cacheWrite, base?.cache.write) },
  }
}
