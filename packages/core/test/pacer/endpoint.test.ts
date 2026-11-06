import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Stream } from "effect"
import { Event } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { sql } from "drizzle-orm"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Integration } from "@opencode/core/integration"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { emptyWellknownNode } from "../fixture/config-nodes"
import { withEnv } from "../fixture/env"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const key = (value: string, baseURL?: string) =>
  Credential.Key.make({ type: "key", key: value, ...(baseURL === undefined ? {} : { metadata: { baseURL } }) })

describe("PacerEndpoint.normalize", () => {
  test("drops a trailing /v1 and trailing slashes, keeping a path prefix", () => {
    const at = (root: string) => ({ origin: new URL(root).origin, root, baseURL: `${root}/v1` })
    expect(PacerEndpoint.normalize("https://cpp.test")).toEqual(at("https://cpp.test"))
    expect(PacerEndpoint.normalize("https://cpp.test/")).toEqual(at("https://cpp.test"))
    expect(PacerEndpoint.normalize("https://cpp.test/v1")).toEqual(at("https://cpp.test"))
    expect(PacerEndpoint.normalize("https://cpp.test/v1/")).toEqual(at("https://cpp.test"))
    expect(PacerEndpoint.normalize("https://cpp.test/proxy")).toEqual(at("https://cpp.test/proxy"))
    expect(PacerEndpoint.normalize("https://cpp.test/proxy/v1/")).toEqual(at("https://cpp.test/proxy"))
    expect(PacerEndpoint.normalize("http://127.0.0.1:8317/v1")).toEqual(at("http://127.0.0.1:8317"))
  })

  test("keeps user info, query and fragment out of every URL", () => {
    expect(PacerEndpoint.normalize("https://user:secret@cpp.test:443/v1?x=1#y")).toEqual({
      origin: "https://cpp.test",
      root: "https://cpp.test",
      baseURL: "https://cpp.test/v1",
    })
  })

  test("refuses what is not an http(s) URL", () => {
    expect(PacerEndpoint.normalize("cpp.test/v1")).toBeUndefined()
    expect(PacerEndpoint.normalize("ftp://cpp.test/v1")).toBeUndefined()
    expect(PacerEndpoint.normalize("file:///v1")).toBeUndefined()
  })
})

describe("PacerEndpoint.resolve", () => {
  const cpp = { origin: "https://cpp.test", root: "https://cpp.test", baseURL: "https://cpp.test/v1" }

  test("takes the credential's key and the base URL its login form stored", () => {
    expect(PacerEndpoint.resolve(undefined, key("k-login", "https://cpp.test/v1"))).toEqual({
      ...cpp,
      key: "k-login",
      keyFrom: "credential",
    })
  })

  test("takes the config's base URL over the login's, and the credential's key over the config's", () => {
    const login = key("k-login", "https://login.test")
    // The model resolver sends the stored credential's key in place of the settings' apiKey; so does CPP's client API.
    expect(PacerEndpoint.resolve({ baseURL: "https://cpp.test/", apiKey: "k-config" }, login)).toEqual({
      ...cpp,
      key: "k-login",
      keyFrom: "credential",
    })
    expect(PacerEndpoint.resolve({ baseURL: "https://cpp.test/v1/" }, login)).toEqual({
      ...cpp,
      key: "k-login",
      keyFrom: "credential",
    })
    expect(PacerEndpoint.resolve({ apiKey: "k-config" }, key("k-login", "https://cpp.test"))).toEqual({
      ...cpp,
      key: "k-login",
      keyFrom: "credential",
    })
    expect(PacerEndpoint.resolve({ baseURL: "https://cpp.test", apiKey: "k-config" }, undefined)).toEqual({
      ...cpp,
      key: "k-config",
      keyFrom: "config",
    })
  })

  test("says where the key came from; the same key moved into the store is a change", () => {
    const config = PacerEndpoint.resolve({ baseURL: "https://cpp.test", apiKey: "k" }, undefined)
    const stored = PacerEndpoint.resolve({ baseURL: "https://cpp.test" }, key("k"))
    expect([config?.keyFrom, stored?.keyFrom]).toEqual(["config", "credential"])
    expect(PacerEndpoint.same(config, stored)).toBe(false)
    expect(PacerEndpoint.same(stored, PacerEndpoint.resolve({ baseURL: "https://cpp.test/v1/" }, key("k")))).toBe(true)
  })

  test("is not set up without both a base URL and a key", () => {
    expect(PacerEndpoint.resolve(undefined, undefined)).toBeUndefined()
    expect(PacerEndpoint.resolve({ baseURL: "https://cpp.test" }, undefined)).toBeUndefined()
    expect(PacerEndpoint.resolve(undefined, key("k-login"))).toBeUndefined()
    // A missing {env:…} substitutes an empty string.
    expect(PacerEndpoint.resolve({ baseURL: "https://cpp.test", apiKey: "" }, undefined)).toBeUndefined()
    expect(PacerEndpoint.resolve({ baseURL: "mailto:cpp", apiKey: "k" }, undefined)).toBeUndefined()
    expect(
      PacerEndpoint.resolve(
        { baseURL: "https://cpp.test" },
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("login"),
          refresh: "r",
          access: "a",
          expires: 0,
        }),
      ),
    ).toBeUndefined()
  })
})

const it = testEffect(Layer.empty)

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

/** The endpoint service with real config files under `root` and an in-memory credential store. */
const services = (root: string) => {
  const watcher = Watcher.testLayer
  return Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([PacerEndpoint.node, Integration.node, Credential.node, Bus.node, Database.node]),
      {
        replacements: [
          PacerEndpoint.node.replace(PacerEndpoint.configured({ system: false })),
          Global.node.replace(Global.layerWith({ config: path.join(root, "config"), home: path.join(root, "home") })),
          WellKnown.node.replace(emptyWellknownNode),
          Watcher.node.replace(watcher),
        ],
      },
    ),
    watcher,
  )
}

const writeConfig = (root: string, config: unknown) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(root, "config"), { recursive: true })
    await fs.writeFile(path.join(root, "config", "opencode.json"), JSON.stringify(config))
  })

/** Waits for the endpoint to match; `changes` starts with the current value, so a change made before still counts. */
const until = (match: (endpoint: PacerEndpoint.Endpoint | undefined) => boolean) =>
  Effect.gen(function* () {
    const endpoints = yield* PacerEndpoint.Service
    return yield* endpoints
      .changes()
      .pipe(
        Stream.filter(match),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die(new Error("endpoint did not change")) }),
      )
  })

/** Runs `body` against the endpoint service of a fresh root, after `prepare` wrote its files. */
const scenario = <A, E>(
  prepare: (root: string) => Effect.Effect<void>,
  body: (
    root: string,
  ) => Effect.Effect<
    A,
    E,
    PacerEndpoint.Service | Integration.Service | Credential.Service | Bus.Service | Database.Service | Watcher.Test
  >,
) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped()).path
    yield* prepare(root)
    return yield* body(root).pipe(Effect.provide(services(root)))
  })

describe("PacerEndpoint.Service", () => {
  it.live("is not set up without config or credential", () =>
    scenario(
      () => Effect.void,
      () =>
        Effect.gen(function* () {
          const endpoints = yield* PacerEndpoint.Service
          expect(yield* endpoints.get()).toBeUndefined()
        }),
    ),
  )

  it.live("follows the integration's active credential as it is created, switched and removed", () =>
    scenario(
      () => Effect.void,
      () =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const first = yield* credentials.create({
            integrationID: PacerEndpoint.id,
            value: key("k-first", "https://first.test/v1"),
          })
          expect(yield* until((endpoint) => endpoint?.key === "k-first")).toMatchObject({
            root: "https://first.test",
          })
          yield* credentials.create({ integrationID: PacerEndpoint.id, value: key("k-second", "https://second.test") })
          expect(yield* until((endpoint) => endpoint?.key === "k-second")).toMatchObject({
            baseURL: "https://second.test/v1",
          })
          yield* credentials.activate(first.id)
          yield* until((endpoint) => endpoint?.key === "k-first")
          yield* credentials.remove(first.id)
          yield* until((endpoint) => endpoint?.key === "k-second")
          // Another integration's credential is not CPP's.
          yield* credentials.create({ integrationID: Integration.ID.make("openai"), value: key("k-other") })
          const endpoints = yield* PacerEndpoint.Service
          expect((yield* endpoints.get())?.key).toBe("k-second")
        }),
    ),
  )

  it.live("reads the global config with {env:} and {file:}; a stored credential's key replaces its apiKey", () =>
    withEnv({ PACER_ENDPOINT_TEST_URL: "https://config.test/proxy/v1/" }, () =>
      scenario(
        (root) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(path.join(root, "config"), { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(path.join(root, "config", "pacer-key"), "k-file\n"))
            yield* writeConfig(root, {
              providers: {
                cliproxypacer: {
                  settings: { baseURL: "{env:PACER_ENDPOINT_TEST_URL}", apiKey: "{file:./pacer-key}" },
                },
              },
            })
          }),
        () =>
          Effect.gen(function* () {
            const credentials = yield* Credential.Service
            const endpoints = yield* PacerEndpoint.Service
            const configured = {
              origin: "https://config.test",
              root: "https://config.test/proxy",
              baseURL: "https://config.test/proxy/v1",
            }
            expect(yield* endpoints.get()).toEqual({ ...configured, key: "k-file", keyFrom: "config" })
            yield* credentials.create({ integrationID: PacerEndpoint.id, value: key("k-login", "https://login.test") })
            expect(yield* until((endpoint) => endpoint?.key === "k-login")).toEqual({
              ...configured,
              key: "k-login",
              keyFrom: "credential",
            })
            const bus = yield* Bus.Service
            // A location's config change re-reads, but changes nothing here.
            yield* bus.publish(Event.Updated, {}, { location: { directory: AbsolutePath.make(path.sep) } })
            expect(yield* endpoints.get()).toEqual({ ...configured, key: "k-login", keyFrom: "credential" })
          }),
      ),
    ),
  )

  it.live("reads v1 provider options too, and takes the credential's key when config has none", () =>
    scenario(
      (root) => writeConfig(root, { provider: { cliproxypacer: { options: { baseURL: "https://v1.test" } } } }),
      () =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          yield* credentials.create({ integrationID: PacerEndpoint.id, value: key("k-login", "https://login.test") })
          expect(yield* until((endpoint) => endpoint !== undefined)).toEqual({
            origin: "https://v1.test",
            root: "https://v1.test",
            baseURL: "https://v1.test/v1",
            key: "k-login",
            keyFrom: "credential",
          })
        }),
    ),
  )

  it.live("notices a global config change", () =>
    scenario(
      (root) =>
        writeConfig(root, { providers: { cliproxypacer: { settings: { baseURL: "https://a.test", apiKey: "k" } } } }),
      (root) =>
        Effect.gen(function* () {
          const watcher = yield* Watcher.Test
          const endpoints = yield* PacerEndpoint.Service
          expect((yield* endpoints.get())?.root).toBe("https://a.test")
          yield* writeConfig(root, {
            providers: { cliproxypacer: { settings: { baseURL: "https://b.test/v1", apiKey: "k" } } },
          })
          yield* watcher.emit({ type: "update", path: path.join(root, "config", "opencode.json") })
          yield* until((endpoint) => endpoint?.root === "https://b.test")
          yield* writeConfig(root, {})
          yield* watcher.emit({ type: "update", path: path.join(root, "config", "opencode.json") })
          yield* until((endpoint) => endpoint === undefined)
        }),
    ),
  )

  it.live("says whether its config gives CPP's address, not a login's, and follows a change", () =>
    scenario(
      (root) => writeConfig(root, { providers: { cliproxypacer: { settings: { baseURL: "https://a.test" } } } }),
      (root) =>
        Effect.gen(function* () {
          const watcher = yield* Watcher.Test
          const endpoints = yield* PacerEndpoint.Service
          const credentials = yield* Credential.Service
          const address = (want: boolean) =>
            required(endpoints.configuredAddress)().pipe(
              Stream.filter((configured) => configured === want),
              Stream.runHead,
              Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die(new Error(`never ${want}`)) }),
            )
          yield* address(true)
          yield* credentials.create({ integrationID: PacerEndpoint.id, value: key("k-login", "https://login.test") })
          yield* until((endpoint) => endpoint?.root === "https://a.test")
          yield* writeConfig(root, {})
          yield* watcher.emit({ type: "update", path: path.join(root, "config", "opencode.json") })
          // The login's address takes over, but it is the form's answer, not config's.
          yield* until((endpoint) => endpoint?.root === "https://login.test")
          yield* address(false)
        }),
    ),
  )

  it.live("never reads a project's config", () =>
    scenario(
      // Above the global config folder, where a project walk from it would find it.
      (root) =>
        Effect.promise(() =>
          fs.writeFile(
            path.join(root, "opencode.json"),
            JSON.stringify({
              providers: { cliproxypacer: { settings: { baseURL: "https://project.test", apiKey: "k" } } },
            }),
          ),
        ),
      () =>
        Effect.gen(function* () {
          const endpoints = yield* PacerEndpoint.Service
          expect(yield* endpoints.get()).toBeUndefined()
          expect(yield* required(endpoints.configuredAddress)().pipe(Stream.runHead)).toEqual(Option.some(false))
        }),
    ),
  )

  it.live("picks the credential Integration.connection.active picks, legacy rows included", () =>
    scenario(
      () => Effect.void,
      () =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrations = yield* Integration.Service
          const bus = yield* Bus.Service
          const db = (yield* Database.Service).db
          const agrees = Effect.gen(function* () {
            const connection = yield* integrations.connection.active(PacerEndpoint.id)
            const stored = connection?.type === "credential" ? yield* credentials.get(connection.id) : undefined
            const expected = stored?.value.type === "key" ? stored.value.key : undefined
            expect(expected).toBeDefined()
            expect((yield* until((endpoint) => endpoint?.key === expected))?.key).toBe(expected)
          })
          const first = yield* credentials.create({
            integrationID: PacerEndpoint.id,
            value: key("k-1", "https://a.test"),
          })
          yield* credentials.create({ integrationID: PacerEndpoint.id, value: key("k-2", "https://a.test") })
          yield* agrees
          yield* credentials.activate(first.id)
          yield* agrees
          yield* credentials.create({
            integrationID: PacerEndpoint.id,
            value: key("k-3", "https://a.test"),
            activate: false,
          })
          yield* agrees
          // Rows from before the active flag: none is active, so the newest one is picked.
          yield* db.run(sql`DELETE FROM credential`)
          for (const [id, created] of [
            ["cred_legacy_old", 1],
            ["cred_legacy_new", 2],
          ] as const)
            yield* db.run(
              sql`INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (${id}, ${PacerEndpoint.id}, ${id}, ${JSON.stringify(key(id, "https://a.test"))}, NULL, ${created}, ${created})`,
            )
          yield* bus.publish(Credential.Event.Updated, {}, { global: true })
          yield* agrees
        }),
    ),
  )

  it.live("watches only the global config folder and $HOME's .agents entry", () =>
    scenario(
      () => Effect.void,
      (root) =>
        Effect.gen(function* () {
          const watcher = yield* Watcher.Test
          expect(
            (yield* watcher.subscriptions()).map((watch) => ({
              path: watch.path,
              type: watch.type,
              ...(watch.type === "entries" ? { names: watch.names } : {}),
            })),
          ).toEqual([
            { path: path.join(root, "config"), type: "directory" },
            { path: path.join(root, "home"), type: "entries", names: [".agents"] },
          ])
        }),
    ),
  )
})
