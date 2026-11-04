import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Product } from "@opencode/schema/product"
import { run, stashDrafts, stashedDrafts } from "@opencode/tui"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Config } from "../../config"
import { Context, Effect, Exit, Fiber, FileSystem, Option, Queue, Scope } from "effect"
import path from "node:path"
import { ServerConnection } from "../../services/server-connection"
import { ReleaseLayout } from "../../upgrade/layout"
import { Release } from "../../upgrade/release"
import { Updater } from "../../upgrade/updater"
import { UpdatePreflight } from "../../services/update-preflight"
import { Npm } from "@opencode/util/npm"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_HIGHLIGHTS, OPENCODE_VERSION } from "../../version"
import { Env } from "../../env"
import { Service, type Endpoint } from "@opencode/client/effect/service"
import { OpenCode } from "@opencode/client/promise"
import { findSession } from "../../session-target"
import { errorMessage } from "../../util/error"
import { TuiDrafts } from "../../tui-drafts"

export default Runtime.handler(Commands, (input) =>
  Effect.gen(function* () {
    const requestedDirectory = Option.getOrUndefined(input.directory)
    const requestedServer = Option.getOrUndefined(input.server)
    if (requestedDirectory !== undefined) process.chdir(requestedDirectory)
    const preflight = UpdatePreflight.make()
    yield* Effect.addFinalizer(() => Effect.promise(() => preflight.close()))
    const serviceStarts = yield* Queue.unbounded<{
      readonly reason: "missing" | "version-mismatch"
      readonly previousVersion?: string
    }>()
    yield* Queue.take(serviceStarts).pipe(
      Effect.flatMap((event) => Effect.logInfo("background service starting", event)),
      Effect.forever,
      Effect.forkScoped,
    )
    const server = yield* ServerConnection.resolve({
      server: requestedServer,
      standalone: input.standalone,
      mismatch: "replace",
      onStart: (reason, previousVersion) => {
        Queue.offerUnsafe(serviceStarts, { reason, previousVersion })
        if (reason === "version-mismatch" && preflight.begin(previousVersion)) return
        process.stderr.write(
          reason === "version-mismatch"
            ? "Restarting background server (version mismatch)...\n"
            : "Starting background server...\n",
        )
      },
    }).pipe(
      Effect.tapError(() =>
        Effect.promise(() => preflight.fail(`${Product.name} update could not start the new background service`)),
      ),
    )
    const session = Option.getOrUndefined(input.session)
    // A missing --session ID becomes the ID of the session the first prompt creates.
    const sessionExists =
      session !== undefined &&
      (yield* Effect.tryPromise({
        try: () =>
          findSession(
            OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) }),
            session,
          ),
        catch: (cause) => new Error(errorMessage(cause)),
      })) !== undefined
    const updater = yield* Updater.Service
    let latest: Updater.State | undefined
    const listeners = new Set<(state: Updater.State) => void>()
    const publish = (state: Updater.State) => {
      latest = state
      listeners.forEach((notify) => notify(state))
    }
    // Upgrades end with this TUI: closing the scope waits for a switch that has begun and cancels any other step.
    const upgrades = yield* Scope.fork(yield* Scope.Scope)
    // Once per start, never on a timer. A standalone server shares the database, so it must not switch it.
    if (!input.standalone) yield* updater.startup(publish).pipe(Effect.forkIn(upgrades, { startImmediately: true }))
    const global = yield* Global.Service
    const releaseBinary = path.join(ReleaseLayout.at(global.data).current, Release.binary)
    const relaunch: { to?: { readonly sessionID?: string } } = {}
    const relaunchable =
      typeof process.execve === "function" &&
      process.platform !== "win32" &&
      requestedServer === undefined &&
      server.service !== undefined &&
      (yield* updater.current()) !== undefined
    preflight.loading()
    const config = yield* Config.Service
    const npm = yield* Npm.Service
    const fileSystem = yield* FileSystem.FileSystem
    const runServicePromise = Effect.runPromiseWith(Context.make(FileSystem.FileSystem, fileSystem))
    const context = yield* Effect.context<FileSystem.FileSystem>()
    const runFork = Effect.runForkWith(context)
    const runPromise = Effect.runPromiseWith(context)
    const service = server.service
    // Half-typed prompts the TUI carried over when it restarted on this release.
    const drafts = path.join(global.state, "drafts")
    stashDrafts(yield* TuiDrafts.take(drafts, process.env))
    // Another process may have switched the release while this TUI was connected; the service then comes back
    // on the release `current` points at.
    const noticeSwitch = async (endpoint: Endpoint) => {
      const info = await OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
        .server.info()
        .catch(() => undefined)
      if (!info || info.version === OPENCODE_VERSION) return
      if ((await runPromise(updater.current())) !== info.version) return
      publish({ type: "switched", version: info.version })
    }
    yield* run({
      app: {
        name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
        version: OPENCODE_VERSION,
        channel: process.env.OPENCODE_TUI_CHANNEL ?? OPENCODE_CHANNEL,
        highlights: OPENCODE_HIGHLIGHTS,
      },
      server: {
        endpoint: server.endpoint,
        // Managed and standalone servers run here; an explicit --server may be on another machine.
        local: requestedServer === undefined,
        service: service
          ? {
              reconnect: (signal) =>
                runServicePromise(service.reconnect(), { signal }).then((endpoint) => {
                  void noticeSwitch(endpoint)
                  return endpoint
                }),
              restart: () => runServicePromise(service.restart()),
            }
          : undefined,
      },
      args: {
        continue: input.continue,
        sessionID: sessionExists ? session : undefined,
        newSessionID: sessionExists ? undefined : session,
        prompt: Option.getOrUndefined(input.prompt),
        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      },
      config: {
        path: config.path,
        get: () => runPromise(config.get()),
        update: (update) => runPromise(config.update(update)),
      },
      updater: {
        remote: requestedServer !== undefined,
        subscribe: (notify) => {
          if (latest) notify(latest)
          listeners.add(notify)
          return () => listeners.delete(notify)
        },
        upgrade: () =>
          input.standalone
            ? Promise.resolve({
                type: "unavailable" as const,
                message: "A --standalone server shares the database; upgrade from openforge without --standalone.",
              })
            : runPromise(
                updater.upgrade({ notify: publish }).pipe(Effect.forkIn(upgrades), Effect.flatMap(Fiber.join)),
              ),
        relaunch: relaunchable ? (sessionID) => (relaunch.to = { sessionID }) : undefined,
      },
      packages: {
        prepare: (spec, install = true) => runPromise(install ? npm.add(spec) : npm.resolve(spec)),
      },
      environment: requestedServer === undefined ? Env.session() : undefined,
      terminalHandoff: () => preflight.finish(),
      log: (level, message, tags) => {
        const effect =
          level === "debug"
            ? Effect.logDebug(message, tags)
            : level === "warn"
              ? Effect.logWarning(message, tags)
              : level === "error"
                ? Effect.logError(message, tags)
                : Effect.logInfo(message, tags)
        runFork(effect)
      },
    }).pipe(Effect.provide(LayerNode.compile(Global.node)))
    if (!relaunch.to) return
    // Same process, same terminal: the TUI restored the terminal when it closed, and the new release sets it up again.
    const args = [
      ...(relaunch.to.sessionID ? ["--session", relaunch.to.sessionID] : []),
      ...(input.auto || input.yolo || input.dangerouslySkipPermissions ? ["--auto"] : []),
    ]
    // The new image replaces this process at once, so let upgrade work release its lock and temporary files first.
    yield* Scope.close(upgrades, Exit.void)
    // The new release puts each half-typed prompt back in its composer. The composers stashed them as the TUI closed.
    const carry = stashedDrafts()
    const kept = yield* TuiDrafts.keep(drafts, carry).pipe(
      Effect.catch((error) =>
        Effect.logWarning("could not keep the half-typed prompts for the restart", { error }).pipe(
          Effect.as(undefined),
        ),
      ),
    )
    const env = kept ? { ...process.env, [TuiDrafts.variable]: kept } : process.env
    yield* Effect.logInfo("restarting the TUI on the release in use", {
      binary: releaseBinary,
      args,
      drafts: carry.length,
    })
    yield* Effect.try(() => process.execve?.(releaseBinary, [releaseBinary, ...args], env)).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          process.stderr.write(
            `Could not restart on the new openforge (${errorMessage(error)}); run openforge again to get the new screens.\n` +
              (kept ? `Your half-typed prompts are kept in ${kept}.\n` : ""),
          ),
        ),
      ),
    )
  }),
)
