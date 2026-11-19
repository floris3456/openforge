import { expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Money } from "@opencode/schema/money"
import { TuiEvent } from "@opencode/schema/tui-event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { endpointAt } from "./memory/fixture"
import { location } from "./fixture/location"
import { it } from "./lib/effect"

// openforge: a run without a session model on a model the config or the agent names, which the catalog lacks. It
// says so once per session ("asked X, running Y"), and for a CLIProxyPacer model whose catalog CPP hasn't answered yet,
// it first waits up to a minute for it.

const ref = location({ directory: AbsolutePath.make("test") })
const state: { endpoint: PacerEndpoint.Endpoint | undefined; catalog: PacerModels.Catalog | undefined } = {
  endpoint: undefined,
  catalog: undefined,
}
const layer = AppNodeBuilder.build(
  LayerNode.group([Bus.node, Provider.node, Model.node, ModelResolver.node, SessionRunnerModel.node]),
  [
    Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(ref))),
    PacerEndpoint.node.replace(
      Layer.succeed(
        PacerEndpoint.Service,
        PacerEndpoint.Service.of({ get: () => Effect.sync(() => state.endpoint), changes: () => Stream.empty }),
      ),
    ),
    PacerModels.node.replace(
      Layer.succeed(
        PacerModels.Service,
        PacerModels.Service.of({
          get: () => Effect.sync(() => state.catalog),
          changes: () => Stream.empty,
          refresh: () => Effect.void,
        }),
      ),
    ),
  ],
)

const other = Provider.ID.make("other")
const local = Model.ID.make("local")
const cpp = Provider.ID.make(PacerEndpoint.id)
const late = Model.ID.make("claude-haiku-5-5")
const PACKAGE = "@opencode/ai/providers/openai-compatible-responses"

const session = (id: string) =>
  Session.Info.make({
    id: Session.ID.make(id),
    projectID: Project.ID.global,
    title: "test",
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: ref,
  })

/** A catalog of `other/local`, with `asked` as the named default, and the toasts told from here on. */
const setup = (asked: { providerID: Provider.ID; modelID: Model.ID }) =>
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const models = yield* Model.Service
    const runner = yield* SessionRunnerModel.Service
    const bus = yield* Bus.Service
    const toasts: { readonly variant: string; readonly message: string }[] = []
    yield* bus.subscribe(TuiEvent.ToastShow).pipe(
      Stream.runForEach((event) => Effect.sync(() => toasts.push(event.data))),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* providers.transform((editor) => {
      editor.update(other, (provider) => {
        provider.package = PACKAGE
        provider.settings = { ...provider.settings, baseURL: "http://127.0.0.1:9/v1" }
      })
      editor.models.update(other, local, () => {})
    })
    yield* models.transform((editor) => editor.default.set(asked.providerID, asked.modelID))
    const resolve = (id: string) =>
      runner
        .resolve(session(id), models.available, { kind: "primary", agent: Agent.ID.make("build") })
        .pipe(Effect.map((resolved) => `${resolved.ref.providerID}/${resolved.ref.id}`))
    /** What CLIProxyPacer's provider does once CPP's catalog is read: it lists the model. */
    const arrive = () =>
      Effect.gen(function* () {
        state.catalog = { at: 0, pacer: null, models: [{ id: late }] }
        yield* providers.transform((editor) => {
          editor.update(cpp, (provider) => {
            provider.package = PACKAGE
            provider.settings = { ...provider.settings, baseURL: "http://127.0.0.1:9/v1" }
          })
          editor.models.update(cpp, late, () => {})
        })
      })
    const warnings = () => toasts.filter((toast) => toast.variant === "warning").map((toast) => toast.message)
    return { resolve, arrive, warnings }
  })

const reset = (input: { endpoint: boolean; catalog?: PacerModels.Catalog }) =>
  Effect.sync(() => {
    state.endpoint = input.endpoint ? endpointAt("http://127.0.0.1:9") : undefined
    state.catalog = input.catalog
  })

it.effect("a dropped named default is told once per session: asked X, running Y", () =>
  Effect.gen(function* () {
    yield* reset({ endpoint: false })
    const chat = yield* setup({ providerID: other, modelID: Model.ID.make("missing") })
    expect(yield* chat.resolve("ses_named_one")).toBe("other/local")
    expect(yield* chat.resolve("ses_named_one")).toBe("other/local")
    expect(chat.warnings()).toEqual(["Asked for other/missing, running other/local: other/missing is not available."])
    expect(yield* chat.resolve("ses_named_two")).toBe("other/local")
    expect(chat.warnings()).toHaveLength(2)
  }).pipe(Effect.provide(layer)),
)

it.effect("a CLIProxyPacer model named before CPP's catalog is read is waited for, and runs when it arrives", () =>
  Effect.gen(function* () {
    yield* reset({ endpoint: true })
    const chat = yield* setup({ providerID: cpp, modelID: late })
    const run = yield* chat.resolve("ses_named_late").pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("30 seconds")
    expect(run.pollUnsafe()).toBeUndefined()
    yield* chat.arrive()
    yield* TestClock.adjust("1 second")
    expect(yield* Fiber.join(run)).toBe(`cliproxypacer/${late}`)
    expect(chat.warnings()).toEqual([])
  }).pipe(Effect.provide(layer)),
)

it.effect("a CLIProxyPacer catalog that never comes is waited for a minute, then the fallback is told", () =>
  Effect.gen(function* () {
    yield* reset({ endpoint: true })
    const chat = yield* setup({ providerID: cpp, modelID: late })
    const run = yield* chat.resolve("ses_named_never").pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("59 seconds")
    expect(run.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust("2 seconds")
    expect(yield* Fiber.join(run)).toBe("other/local")
    expect(chat.warnings()).toEqual([
      `Asked for cliproxypacer/${late}, running other/local: cliproxypacer/${late} is not available.`,
    ])
    // The same chat's next step doesn't wait again.
    expect(yield* chat.resolve("ses_named_never")).toBe("other/local")
  }).pipe(Effect.provide(layer)),
)

it.effect("a CLIProxyPacer model CPP's read catalog lacks is not waited for", () =>
  Effect.gen(function* () {
    yield* reset({ endpoint: true, catalog: { at: 0, pacer: null, models: [{ id: "other-model" }] } })
    const chat = yield* setup({ providerID: cpp, modelID: late })
    expect(yield* chat.resolve("ses_named_absent")).toBe("other/local")
    expect(chat.warnings()).toHaveLength(1)
  }).pipe(Effect.provide(layer)),
)
