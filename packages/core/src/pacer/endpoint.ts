export * as PacerEndpoint from "./endpoint.js"

import { Context, Effect, Layer, Semaphore, Stream, SubscriptionRef } from "effect"
import { Event } from "@opencode/schema/config"
import { Integration } from "@opencode/schema/integration"
import { ProjectID } from "@opencode/schema/project-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Credential } from "../credential.js"
import { Watcher } from "../filesystem/watcher.js"
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
    a?.keyFrom === b?.keyFrom
  )
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
      const current = yield* SubscriptionRef.make<Endpoint | undefined>(undefined)
      const address = yield* SubscriptionRef.make(false)
      const lock = Semaphore.makeUnsafe(1)
      const refresh = Effect.fn("PacerEndpoint.refresh")(
        function* () {
          const next = yield* load()
          if (next.address !== (yield* SubscriptionRef.get(address))) yield* SubscriptionRef.set(address, next.address)
          if (same(next.endpoint, yield* SubscriptionRef.get(current))) return
          yield* SubscriptionRef.set(current, next.endpoint)
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
      })
    }),
  )
}

export function configured(options?: Config.Options) {
  return makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [Bus.node, Credential.node, Global.node, FSUtil.node, Watcher.node, WellKnown.node, AppProcess.node],
  })
}

export const node = configured()
