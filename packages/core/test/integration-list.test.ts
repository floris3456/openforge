import path from "path"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { Document, Event, Info } from "@opencode/schema/config"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Credential } from "@opencode/core/credential"
import { CredentialTable } from "@opencode/core/credential/sql"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Integration } from "@opencode/core/integration"
import { IntegrationConnection } from "@opencode/core/integration/connection"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { withEnv } from "./fixture/env"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// Integration.list keeps an integration's Info until the integration or its connections change. Each test here
// changes one thing the list reads, after a read, and checks that the next list, get, Provider snapshot and Model
// list show it.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Provider.node, Model.node, Bus.node, Credential.node, Integration.node, Database.node]),
    [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("test") }))),
      ),
    ],
  ),
)

const acme = Integration.ID.make("acme")
const providerID = Provider.ID.make("acme")
const chat = Model.ID.make("chat")
const ENV = "INTEGRATION_LIST_TEST_ACME_KEY"

// The provider is offered only while its integration has a connection.
const addProvider = Effect.gen(function* () {
  const providers = yield* Provider.Service
  yield* providers.transform((editor) =>
    editor.add({ info: Provider.Info.empty(providerID), models: [Model.Info.default(providerID, chat)] }),
  )
})

const register = Effect.gen(function* () {
  const integrations = yield* Integration.Service
  yield* integrations.transform((editor) => {
    editor.update(acme, (integration) => (integration.name = "Acme"))
    editor.method.update({ integrationID: acme, method: { type: "key", label: "API key" } })
    editor.method.update({ integrationID: acme, method: { type: "env", names: [ENV] } })
  })
  yield* addProvider
})

const summary = (connection: IntegrationConnection.Info) =>
  (connection.type === "credential" ? connection.label : `env ${connection.name}`) +
  (connection.status ? ` (${connection.status.message})` : "")

// What a reader sees of acme: the list's entry, which a get must match, and whether its provider and model are offered.
const seen = Effect.gen(function* () {
  const integrations = yield* Integration.Service
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  const listed = (yield* integrations.list()).find((integration) => integration.id === acme)
  expect(yield* integrations.get(acme)).toEqual(listed)
  return {
    name: listed?.name,
    methods: listed?.methods.map((method): string => method.type),
    connections: listed?.connections.map(summary),
    providers: (yield* providers.available()).map((provider): string => provider.id),
    models: (yield* models.available()).map((model): string => model.id),
  }
})

const unconnected = { name: "Acme", methods: ["key", "env"], connections: [], providers: [], models: [] }
const connected = (...connections: string[]) => ({
  ...unconnected,
  connections,
  providers: [providerID],
  models: [chat],
})

describe("Integration.list", () => {
  it.effect("keeps an unchanged integration's Info between lists and makes it again once it changes", () =>
    withEnv({ [ENV]: undefined }, () =>
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const other = Integration.ID.make("other")
        yield* register
        yield* integrations.transform((editor) => editor.update(other, (integration) => (integration.name = "Other")))
        const find = (list: readonly Integration.Info[], id: Integration.ID) =>
          list.find((integration) => integration.id === id)

        const first = yield* integrations.list()
        const second = yield* integrations.list()
        expect(second).toEqual(first)
        second.forEach((integration, index) => expect(integration).toBe(first[index]!))
        expect(yield* integrations.get(acme)).toBe(find(first, acme)!)

        yield* integrations.connection.key({ integrationID: acme, key: "secret" })
        const third = yield* integrations.list()
        expect(find(third, acme)).not.toBe(find(first, acme))
        expect(find(third, acme)?.connections).toHaveLength(1)
        expect(find(third, other)).toBe(find(first, other)!)
      }),
    ),
  )

  it.effect("shows a connect, another credential, a switch, a rename, a status and a disconnect", () =>
    withEnv({ [ENV]: undefined }, () =>
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        yield* register
        expect(yield* seen).toEqual(unconnected)

        yield* integrations.connection.key({ integrationID: acme, key: "first", label: "Work" })
        expect(yield* seen).toEqual(connected("Work"))
        const work = (yield* credentials.list(acme))[0]!

        const personal = yield* credentials.create({
          integrationID: acme,
          label: "Personal",
          value: Credential.Key.make({ type: "key", key: "second" }),
        })
        expect(yield* seen).toEqual(connected("Personal", "Work"))

        yield* integrations.connection.activate(work.id)
        expect(yield* seen).toEqual(connected("Work", "Personal"))

        yield* integrations.connection.update(work.id, { label: "Office" })
        expect(yield* seen).toEqual(connected("Office", "Personal"))

        const office = { type: "credential", id: work.id, label: "Office", method: "key" } as const
        yield* integrations.connection.status({
          integrationID: acme,
          connection: office,
          status: { status: "needs_auth", message: "sign in again" },
        })
        expect(yield* seen).toEqual(connected("Office (sign in again)", "Personal"))
        yield* integrations.connection.status({ integrationID: acme, connection: office, status: undefined })
        expect(yield* seen).toEqual(connected("Office", "Personal"))

        yield* integrations.connection.remove(work.id)
        expect(yield* seen).toEqual(connected("Personal"))
        yield* integrations.connection.remove(personal.id)
        expect(yield* seen).toEqual(unconnected)
      }),
    ),
  )

  // Another process sharing the database publishes nothing here, so only reading the credentials shows its writes.
  it.effect("shows a credential another process stored or removed", () =>
    withEnv({ [ENV]: undefined }, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* register
        expect(yield* seen).toEqual(unconnected)

        const id = Credential.ID.create()
        yield* database.db
          .insert(CredentialTable)
          .values({
            id,
            integration_id: acme,
            label: "Elsewhere",
            value: Credential.Key.make({ type: "key", key: "secret" }),
            active: true,
          })
          .run()
          .pipe(Effect.orDie)
        expect(yield* seen).toEqual(connected("Elsewhere"))

        yield* database.db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
        expect(yield* seen).toEqual(unconnected)
      }),
    ),
  )

  it.effect("shows an env var set or cleared", () =>
    withEnv({ [ENV]: undefined }, () =>
      Effect.gen(function* () {
        yield* register
        expect(yield* seen).toEqual(unconnected)
        yield* withEnv({ [ENV]: "secret" }, () =>
          Effect.gen(function* () {
            expect(yield* seen).toEqual(connected(`env ${ENV}`))
          }),
        )
        expect(yield* seen).toEqual(unconnected)
      }),
    ),
  )

  it.effect("shows a reload after a registration's input changed, and a registration loaded or unloaded", () =>
    withEnv({ [ENV]: "secret" }, () =>
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        // What a config-backed transform reads; a config change sets it and reloads, as ConfigProviderPlugin does.
        const input = { name: "Acme", env: [] as string[] }
        yield* integrations.transform((editor) => {
          editor.update(acme, (integration) => (integration.name = input.name))
          editor.method.update({ integrationID: acme, method: { type: "key", label: "API key" } })
          if (input.env.length > 0)
            editor.method.update({ integrationID: acme, method: { type: "env", names: input.env } })
        })
        yield* addProvider
        expect(yield* seen).toEqual({ ...unconnected, methods: ["key"] })

        input.name = "Acme Renamed"
        yield* integrations.reload()
        expect(yield* seen).toEqual({ ...unconnected, name: "Acme Renamed", methods: ["key"] })

        input.env = [ENV]
        yield* integrations.reload()
        expect(yield* seen).toEqual({ ...connected(`env ${ENV}`), name: "Acme Renamed" })

        // A plugin loaded later renames it; unloading the plugin brings the earlier name back.
        const plugin = yield* Scope.fork(yield* Scope.Scope)
        yield* integrations
          .transform((editor) => editor.update(acme, (integration) => (integration.name = "Acme by a plugin")))
          .pipe(Scope.provide(plugin))
        expect(yield* seen).toEqual({ ...connected(`env ${ENV}`), name: "Acme by a plugin" })
        yield* Scope.close(plugin, Exit.void)
        expect(yield* seen).toEqual({ ...connected(`env ${ENV}`), name: "Acme Renamed" })
      }),
    ),
  )
})

const pluginIt = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Info)
const custom = (provider: { readonly name: string; readonly env?: readonly string[]; readonly models: string[] }) =>
  new Document({
    type: "document",
    path: AbsolutePath.make(path.join(import.meta.dir, "opencode.json")),
    info: decode({
      providers: {
        custom: { ...provider, models: Object.fromEntries(provider.models.map((model) => [model, {}])) },
      },
    }),
  })

describe("Integration.list after a config change", () => {
  pluginIt.live("shows a configured provider's new name, then its env and models, in the next list and snapshot", () =>
    withEnv({ [ENV]: "secret" }, () =>
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const models = yield* Model.Service
        const bus = yield* Bus.Service
        const plugins = yield* Plugin.Service
        const test = yield* Config.Test
        yield* ConfigProviderPlugin.Plugin.effect(yield* PluginHost.make(plugins))
        const read = Effect.gen(function* () {
          const listed = (yield* integrations.list()).find((integration) => integration.id === "custom")
          return {
            name: listed?.name,
            methods: listed?.methods.map((method): string => method.type),
            connections: listed?.connections.map(summary),
            models: (yield* models.available())
              .filter((model) => model.providerID === "custom")
              .map((model): string => model.id)
              .toSorted(),
          }
        })
        // The config plugin reloads the integrations, then the providers, once it sees the change.
        const next = (entry: Document, expected: Effect.Success<typeof read>) =>
          Effect.gen(function* () {
            yield* test.setEntries([entry])
            yield* bus.publish(Event.Updated, {})
            const deadline = Date.now() + 10_000
            while (!Bun.deepEquals(yield* read, expected) && Date.now() < deadline) yield* Effect.sleep("10 millis")
            expect(yield* read).toEqual(expected)
          })
        expect(yield* read).toEqual({ name: "Custom", methods: ["key"], connections: [], models: ["chat"] })

        yield* next(custom({ name: "Custom Renamed", models: ["chat"] }), {
          name: "Custom Renamed",
          methods: ["key"],
          connections: [],
          models: ["chat"],
        })
        yield* next(custom({ name: "Custom Renamed", env: [ENV], models: ["chat", "fast"] }), {
          name: "Custom Renamed",
          methods: ["key", "env"],
          connections: [`env ${ENV}`],
          models: ["chat", "fast"],
        })
      }).pipe(Effect.provide(Config.testLayer([custom({ name: "Custom", models: ["chat"] })]))),
    ),
  )
})
