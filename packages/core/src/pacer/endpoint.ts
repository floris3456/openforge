export * as PacerEndpoint from "./endpoint.js"

import { Context, Effect, Fiber, FiberHandle, Layer, Option, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Event } from "@opencode/schema/config"
import { Integration } from "@opencode/schema/integration"
import { ProjectID } from "@opencode/schema/project-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Credential } from "../credential.js"
import { Watcher } from "../filesystem/watcher.js"
import { KV } from "../kv.js"
import { Location } from "../location.js"
import { foldSettings } from "../plugin/provider/configured.js"
import type { Provider } from "../provider.js"
import { AbsolutePath } from "../schema.js"
import { WellKnown } from "../wellknown.js"

/** The provider and integration CPP is set up under. */
export const id = Integration.ID.make("cliproxypacer")

/** Where CPP is, and the client key it is called with. */
export interface Endpoint {
  /** `scheme://host[:port]`, the only origin the key is ever sent to. */
  readonly origin: string
  /** The base URL without `/v1`: CPP's `/pacer/v1/*`, `/healthz` and Anthropic's `/v1/messages` hang off it. */
  readonly root: string
  /** `root + "/v1"`, for the OpenAI routes. */
  readonly baseURL: string
  readonly key: string
  /** Where the key came from: the integration's credential store, or config's `apiKey`. */
  readonly keyFrom: "credential" | "config"
  /** The set-up address's root while CPP is reached at another address of its list; absent on the set-up one. */
  readonly home?: string
}

/** One address CPP is reached at, as capabilities' `pacer.addresses` gives it. */
export interface Address {
  readonly origin: string
  readonly root: string
  readonly baseURL: string
  /** The instance answering there; absent for the public address. */
  readonly instance?: string
  /** Whether that instance is the active one. */
  readonly active?: boolean
  /** The public address, which reaches whichever instance is active. */
  readonly public?: boolean
}

export interface Interface {
  /** The endpoint now; undefined while CPP is not set up. */
  readonly get: () => Effect.Effect<Endpoint | undefined>
  /** The endpoint now, then each change of it. */
  readonly changes: () => Stream.Stream<Endpoint | undefined>
  /**
   * Whether config gives CPP's address, read where `get` reads it: now, then each change. The login form asks for the
   * address only when not, so the form and the endpoint never disagree. Absent in stand-ins; the form then asks.
   */
  readonly configuredAddress?: () => Stream.Stream<boolean>
  /** The addresses CPP is reached at: the set-up one first, then those its capabilities named. Absent in stand-ins. */
  readonly addresses?: () => Effect.Effect<ReadonlyArray<Address>>
  /**
   * Takes the addresses a capabilities answer to `from` named. Ignored unless `from` carries the set-up key and is
   * an address of the list, so only CPP itself, asked with the key, extends where the key is sent.
   */
  readonly learn?: (from: Endpoint, addresses: ReadonlyArray<Address>) => Effect.Effect<void>
  /**
   * After an outage at `from` (the current endpoint by default), moves to the first other address of the list whose
   * `/healthz` answers 200: the active instance's, the other instances', the public one last. True when the endpoint
   * is now another one than `from`.
   */
  readonly failover?: (from?: Endpoint) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerEndpoint") {}

/**
 * Where CPP is, from provider settings and the integration's active credential: the settings' `baseURL`, else the
 * one a `key` credential's login form stored as metadata; the credential's key, else the settings' `apiKey`. The key
 * takes the model resolver's order, which sends a stored credential's key in place of the settings' `apiKey`
 * (`loadCatalogPackage` in model-resolver.ts), so model requests and CPP's client API always carry the same key.
 * Undefined when either the base URL or the key is missing, or the URL is not http(s).
 */
export function resolve(settings: Provider.Settings | undefined, credential: Credential.Value | undefined) {
  const login = credential?.type === "key" ? credential : undefined
  const url = text(settings?.baseURL) ?? text(login?.metadata?.baseURL)
  const stored = text(login?.key)
  const key = stored ?? text(settings?.apiKey)
  if (url === undefined || key === undefined) return undefined
  const location = normalize(url)
  return location && ({ ...location, key, keyFrom: stored ? "credential" : "config" } satisfies Endpoint)
}

/** Accepts `https://host`, `https://host/`, `https://host/v1`, `https://host/v1/`, with or without a path prefix. */
export function normalize(baseURL: string) {
  if (!URL.canParse(baseURL)) return undefined
  const url = new URL(baseURL)
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  // Built from the origin, so user info, query and fragment never become part of a request URL.
  const root = url.origin + url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")
  return { origin: url.origin, root, baseURL: `${root}/v1` }
}

/** Whether two endpoints are the same address with the same key from the same place. */
export function same(a: Endpoint | undefined, b: Endpoint | undefined) {
  return (
    a?.root === b?.root &&
    a?.origin === b?.origin &&
    a?.baseURL === b?.baseURL &&
    a?.key === b?.key &&
    a?.keyFrom === b?.keyFrom &&
    a?.home === b?.home
  )
}

/** Whether two endpoints reach the same CPP with the same key: the set-up address the same, whichever of its pair's. */
export function sameServer(a: Endpoint | undefined, b: Endpoint | undefined) {
  if (!a || !b) return false
  return (a.home ?? a.root) === (b.home ?? b.root) && a.key === b.key && a.keyFrom === b.keyFrom
}

const AddressEntry = Schema.Struct({
  url: Schema.String,
  instance: Schema.optional(Schema.NullOr(Schema.String)),
  active: Schema.optional(Schema.NullOr(Schema.Boolean)),
  public: Schema.optional(Schema.NullOr(Schema.Boolean)),
})
const decodeAddress = Schema.decodeUnknownOption(AddressEntry)

/**
 * Capabilities' `pacer.addresses`, each entry decoded on its own so a malformed one drops only itself; undefined when
 * it is not a list (an older server has no key).
 */
export function addressesOf(items: unknown): ReadonlyArray<Address> | undefined {
  if (!Array.isArray(items)) return undefined
  return items.flatMap((item) => {
    const entry = Option.getOrUndefined(decodeAddress(item))
    const location = entry && normalize(entry.url)
    if (!entry || !location) return []
    return [
      {
        ...location,
        ...(typeof entry.instance === "string" ? { instance: entry.instance } : {}),
        ...(entry.active === true ? { active: true } : {}),
        ...(entry.public === true ? { public: true } : {}),
      },
    ]
  })
}

/** The list for a set-up endpoint: its own address first, with what the learned entry for it says, then the others once each. */
function listOf(home: Endpoint, learned: ReadonlyArray<Address>): ReadonlyArray<Address> {
  const own = learned.find((address) => address.root === home.root)
  const seen = new Set([home.root])
  return [
    { ...own, origin: home.origin, root: home.root, baseURL: home.baseURL },
    ...learned.filter((address) => {
      if (seen.has(address.root)) return false
      seen.add(address.root)
      return true
    }),
  ]
}

/** The order an outage tries the other addresses in: the active instance, the other instances, the public one last. */
function rank(address: Address) {
  if (address.public) return 2
  return address.active ? 0 : 1
}

/** The stored list belongs to a set-up address and key; the key is kept only as part of its SHA-256. */
const Stored = Schema.Struct({ home: Schema.String, key: Schema.String, addresses: Schema.Array(Schema.Unknown) })
const decodeStored = Schema.decodeUnknownOption(Stored)
const storeKey = "pacer:addresses"

function digest(key: string) {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 16)
}

function entry(address: Address) {
  return {
    url: address.root,
    ...(address.instance === undefined ? {} : { instance: address.instance }),
    ...(address.active ? { active: true } : {}),
    ...(address.public ? { public: true } : {}),
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/**
 * Process-wide: the service holds one CPP connection for every location, and the key lives in the global credential
 * store. Config is read as it is outside any project (system, managed, well-known and global config, plus an explicit
 * file or content), through Config's own loader, so a project's config never moves the service's connection. Config
 * has no process-wide instance (it is a location node), so this layer keeps one at the global config folder: it
 * watches that folder (the same watch every location's Config holds, shared by Watcher) and `$HOME`'s `.agents`
 * entry, and reads the global config files once at start, once when its watches are ready, and after each change.
 */
export function layer(options?: Config.Options) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const credentials = yield* Credential.Service
      const bus = yield* Bus.Service
      const directory = AbsolutePath.make(global.config)
      // Config needs a Location; at the global config folder no project walk runs.
      const config = yield* Layer.build(
        Config.layer({ ...options, project: false, claude: false }).pipe(
          Layer.provide(
            Layer.succeed(
              Location.Service,
              Location.Service.of({
                directory,
                project: { id: ProjectID.global, directory, canonical: directory },
              }),
            ),
          ),
        ),
      ).pipe(Effect.map((context) => Context.get(context, Config.Service)))

      const load = Effect.fn("PacerEndpoint.load")(function* () {
        const settings = foldSettings(yield* config.entries(), id, undefined)
        // Integration.connection.active, a location service, picks the same one: Credential.list orders the active
        // credential last, and the integration takes the reversed list's first (resolveConnections).
        const credential = (yield* credentials.list(id)).at(-1)
        // Config's address wins over the one a login stored, as in `resolve`.
        return { endpoint: resolve(settings, credential?.value), address: text(settings?.baseURL) !== undefined }
      })
      const kv = yield* KV.Service
      const http = yield* HttpClient.HttpClient
      const scope = yield* Effect.scope
      const current = yield* SubscriptionRef.make<Endpoint | undefined>(undefined)
      const address = yield* SubscriptionRef.make(false)
      const lock = Semaphore.makeUnsafe(1)
      // While on another address, the fiber that checks the set-up one and moves back.
      const back = yield* FiberHandle.make()
      // The set-up endpoint, and the addresses it is reached at, the set-up one first.
      let home: Endpoint | undefined
      let list: ReadonlyArray<Address> = []

      const stored = Effect.fn("PacerEndpoint.stored")(function* (endpoint: Endpoint) {
        const record = yield* kv.get(storeKey)
        if (record === undefined) return listOf(endpoint, [])
        const value = Option.getOrUndefined(decodeStored(record))
        if (value?.home === endpoint.root && value.key === digest(endpoint.key))
          return listOf(endpoint, addressesOf(value.addresses) ?? [])
        // Another address or key is set up now: its list starts over.
        yield* kv.remove(storeKey)
        return listOf(endpoint, [])
      })

      const at = (target: Address) =>
        home &&
        (target.root === home.root
          ? home
          : { ...home, origin: target.origin, root: target.root, baseURL: target.baseURL, home: home.root })

      // No key: `/healthz` is open, and an address answers it before it is trusted with anything.
      const healthy = (root: string) =>
        http.execute(HttpClientRequest.get(`${root}/healthz`)).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.map((response) => response.status === 200),
          Effect.timeout("2 seconds"),
          Effect.orElseSucceed(() => false),
        )

      // Two 200s in a row from the set-up address, a minute apart, move back to it.
      const watch = Effect.gen(function* () {
        let streak = 0
        while (streak < 2) {
          yield* Effect.sleep("60 seconds")
          const root = home?.root
          streak = root !== undefined && (yield* healthy(root)) ? streak + 1 : 0
        }
        yield* lock.withPermit(
          Effect.gen(function* () {
            if (home && (yield* SubscriptionRef.get(current))?.home !== undefined)
              yield* SubscriptionRef.set(current, home)
          }),
        )
      })

      const refresh = Effect.fn("PacerEndpoint.refresh")(
        function* () {
          const next = yield* load()
          if (next.address !== (yield* SubscriptionRef.get(address))) yield* SubscriptionRef.set(address, next.address)
          if (same(next.endpoint, home)) return
          home = next.endpoint
          list = home ? yield* stored(home) : []
          yield* FiberHandle.clear(back)
          if (same(home, yield* SubscriptionRef.get(current))) return
          yield* SubscriptionRef.set(current, home)
        },
        (effect) => lock.withPermit(effect),
      )

      const learn = Effect.fn("PacerEndpoint.learn")(
        function* (from: Endpoint, addresses: ReadonlyArray<Address>) {
          if (!home || from.key !== home.key || from.keyFrom !== home.keyFrom) return
          if (!list.some((item) => item.root === from.root)) return
          const next = listOf(home, addresses)
          if (JSON.stringify(next) === JSON.stringify(list)) return
          list = next
          yield* kv.set(storeKey, { home: home.root, key: digest(home.key), addresses: next.slice(1).map(entry) })
        },
        (effect) => lock.withPermit(effect),
      )

      const move = Effect.fn("PacerEndpoint.failover")(
        function* (from: Endpoint | undefined) {
          const now = yield* SubscriptionRef.get(current)
          if (!now || !home) return false
          // Another outage moved it meanwhile.
          if (from && !same(from, now)) return true
          const found = yield* Effect.findFirst(
            list.filter((item) => item.root !== now.root).toSorted((a, b) => rank(a) - rank(b)),
            (item) => healthy(item.root),
          )
          const target = Option.getOrUndefined(found)
          const next = target && at(target)
          if (!next) return false
          yield* SubscriptionRef.set(current, next)
          if (next.home === undefined) yield* FiberHandle.clear(back)
          if (next.home !== undefined) yield* FiberHandle.run(back, watch, { onlyIfMissing: true })
          return true
        },
        (effect) => lock.withPermit(effect),
      )
      // Subscribed before the first read, so a change made meanwhile is not missed. A location's config.updated
      // also arrives here (this layer has no ambient Location); the comparison drops it when nothing changed.
      yield* bus
        .subscribe([Event.Updated, Credential.Event.Updated, Credential.Event.Switched])
        .pipe(Stream.runForEach(refresh), Effect.forkScoped({ startImmediately: true }))
      yield* refresh()

      return Service.of({
        get: () => SubscriptionRef.get(current),
        changes: () => SubscriptionRef.changes(current),
        configuredAddress: () => SubscriptionRef.changes(address),
        addresses: () => lock.withPermit(Effect.sync(() => list)),
        learn,
        // In the layer's scope, so a caller interrupted by the move it caused (a read that follows the endpoint) does
        // not cut the move short.
        failover: (from) => Effect.forkIn(move(from), scope).pipe(Effect.flatMap(Fiber.join)),
      })
    }),
  )
}

export function configured(options?: Config.Options) {
  return makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [
      Bus.node,
      Credential.node,
      Global.node,
      FSUtil.node,
      Watcher.node,
      WellKnown.node,
      AppProcess.node,
      KV.node,
      httpClient,
    ],
  })
}

export const node = configured()
