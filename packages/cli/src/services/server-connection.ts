import { Service, type Endpoint, type EnsureOptions } from "@opencode/client/effect/service"
import { ClientError, isUnauthorizedError, OpenCode } from "@opencode/client/promise"
import { OPENCODE_VERSION } from "../version"
import { Effect, Fiber, Option, Redacted } from "effect"
import { Server as ServerFlag, Standalone as StandaloneFlag } from "../commands/commands"
import { Env } from "../env"
import { Updater } from "../upgrade/updater"
import { ServiceConfig } from "./service-config"
import { Standalone } from "./standalone"
import { errorMessage } from "../util/error"

export type Args = {
  readonly server?: string
  readonly standalone?: boolean
  readonly mismatch?: "replace" | "ignore" | "error"
  readonly onStart?: EnsureOptions["onStart"]
}

export type Resolved = {
  readonly endpoint: Endpoint
  readonly service?: ReturnType<typeof managedService>
}

export const resolve = Effect.fn("cli.server-connection.resolve")(function* (args: Args = {}) {
  const serverFlag = yield* Effect.serviceOption(ServerFlag).pipe(Effect.map(Option.flatten))
  const standaloneFlag = yield* Effect.serviceOption(StandaloneFlag)
  const server = args.server ?? Option.getOrUndefined(serverFlag)
  const standalone = args.standalone ?? Option.getOrElse(standaloneFlag, () => false)
  if (server !== undefined && standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  if (server !== undefined) {
    const password = yield* Env.password
    const endpoint = {
      url: server,
      auth: password ? { type: "basic" as const, username: "opencode", password: Redacted.value(password) } : undefined,
    } satisfies Endpoint
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const health = yield* Effect.tryPromise({
      try: () => client.server.info({ signal: AbortSignal.timeout(5_000) }),
      catch: (cause) => connectError(endpoint, cause),
    })
    if (health.version !== OPENCODE_VERSION)
      process.stderr.write(
        `Warning: Server at ${endpoint.url} has version ${health.version}; this client is ${OPENCODE_VERSION}. Continuing anyway.\n`,
      )
    return { endpoint } satisfies Resolved
  }
  if (standalone || (yield* ServiceConfig.read()).disabled === true) {
    return { endpoint: yield* Standalone.start() } satisfies Resolved
  }

  const mismatch = args.mismatch ?? "ignore"
  const options = yield* ServiceConfig.options({ checkVersion: mismatch !== "ignore" })
  // A release switch stops the service and starts the next one. A client that started one of its own meanwhile would
  // start the release it runs, the old one, so until the switch is done it only looks for the service the switch
  // starts. Every command of the CLI has the updater (see cli.ts); a caller without it does not wait.
  const updater = yield* Effect.serviceOption(Updater.Service)
  const switched = Option.match(updater, { onNone: () => Effect.void, onSome: (updater) => updater.switched() })
  return {
    endpoint: yield* resolveManaged({ ...options, onStart: args.onStart }, mismatch),
    service: managedService(options, switched),
  } satisfies Resolved
})

function managedService(options: EnsureOptions, switched: Effect.Effect<void>) {
  const reconnectOptions = { ...options, version: undefined }
  return {
    // The service a switch starts is taken as soon as it is registered, while it is still paused, so that the writes
    // a client resends reach it the moment it resumes. The wait for the switch's lock cannot be interrupted, so it
    // runs on its own and ends with the switch.
    reconnect: () =>
      Effect.gen(function* () {
        const switching = yield* Effect.forkDetach(switched)
        const found = yield* Effect.raceFirst(
          Service.discovered(reconnectOptions).pipe(Effect.map(Option.some)),
          Fiber.join(switching).pipe(Effect.as(Option.none<Endpoint>())),
        )
        if (Option.isSome(found)) return found.value
        return yield* Service.ensure(reconnectOptions)
      }),
    restart: () =>
      Effect.gen(function* () {
        yield* switched
        yield* Service.stop({ file: options.file, pty: "handoff" })
        yield* Service.ensure(reconnectOptions)
      }),
  }
}

export const shutdownPersistentPty = Effect.fn("cli.server-connection.shutdown-persistent-pty")(function* (
  options: EnsureOptions,
) {
  const endpoint = yield* Service.discover({ ...options, version: undefined })
  if (!endpoint) return
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  yield* Effect.tryPromise(() => client.experimental.persistentPty.shutdown())
})

const resolveManaged = Effect.fnUntraced(function* (options: EnsureOptions, mismatch: NonNullable<Args["mismatch"]>) {
  if (mismatch === "replace") return yield* Service.ensure(options)
  if (mismatch === "ignore") return yield* Service.ensure({ ...options, version: undefined })

  const compatible = yield* Service.discover(options)
  if (compatible !== undefined) return compatible
  const existing = yield* Service.discover({ ...options, version: undefined })
  if (existing !== undefined)
    return yield* Effect.fail(new Error("Background server version does not match this client"))
  return yield* Service.ensure(options)
})

function connectError(endpoint: Endpoint, cause: unknown) {
  if (isUnauthorizedError(cause)) {
    return new Error(
      endpoint.auth === undefined
        ? `Server at ${endpoint.url} requires a password; set OPENCODE_PASSWORD`
        : `Server at ${endpoint.url} rejected the password`,
      { cause },
    )
  }
  if (cause instanceof ClientError && cause.reason === "Transport")
    return new Error(`Could not reach server at ${endpoint.url}: ${errorMessage(cause.cause ?? cause)}`, { cause })
  return new Error(
    `Server at ${endpoint.url} did not provide a compatible V2 health response: ${errorMessage(cause)}`,
    { cause },
  )
}

export * as ServerConnection from "./server-connection"
