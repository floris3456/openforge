// openforge's self-upgrade: one install method (GitHub releases, see ./release.ts), checked once at startup and
// on `/update` or `openforge upgrade`; never on a timer.

import type { UpgradeOutcome, UpgradeState } from "@opencode/client/promise"
import { RunnerPaths } from "@opencode/runner/paths"
import { Product } from "@opencode/schema/product"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Context, Duration, Effect, FileSystem, Layer, Option, Semaphore } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import { databasePath } from "../database-path"
import { ServiceConfig } from "../services/service-config"
import { OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { ReleaseDatabase } from "./database"
import { ReleaseLayout } from "./layout"
import { Release, UpgradeError } from "./release"
import { ReleaseSwitch } from "./switch"
import { SwitchLock } from "./switch-lock"
import { ReleaseVersion } from "./version"

export type Policy = "disable" | "notify" | "auto"

// Several processes may install the same release at once; one downloads, the others wait and find it installed.
const installLock = { key: "openforge-release-install", timeout: Duration.minutes(15) }

export type UpgradeInput = {
  /** A version to switch to, kept or downloaded; the latest release when omitted. */
  readonly target?: string
  /** Use the database copy made when `target` was left instead of the current database. */
  readonly restoreDatabase?: boolean
  readonly notify?: (state: UpgradeState) => void
}

export interface Interface {
  /** The release `current` points at, when this openforge runs from the install layout. */
  readonly current: () => Effect.Effect<string | undefined>
  /** Once at startup: tells about (`notify`) or switches to (`auto`) a newer release. Never fails. */
  readonly startup: (notify: (state: UpgradeState) => void) => Effect.Effect<void>
  /** Installs a release and switches to it while chats run, whatever the policy. */
  readonly upgrade: (input?: UpgradeInput) => Effect.Effect<UpgradeOutcome, UpgradeError>
  /** Returns once no process is switching releases, so the service in use is the one the switch left. */
  readonly switched: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export type Options = {
  readonly data: string
  /** The releases' tool runner folders; a release whose runner still runs is never removed. */
  readonly runners?: string
  readonly config: string
  readonly log: string
  readonly version: string
  readonly local: boolean
  readonly disabled: boolean
  /** Real path of the running binary. */
  readonly executable: string
  readonly platform: Release.Platform | undefined
  readonly base: string
  readonly database: string
  readonly service: Effect.Effect<ReleaseSwitch.Target["service"], UpgradeError>
  /**
   * Whether the background service is turned off (`openforge service set disabled true`). Each TUI then runs its own
   * server on the database, which a switch can't pause, and a switch would start a service beside them.
   */
  readonly serviceDisabled: Effect.Effect<boolean>
  /** How long a started service gets to answer; 10 s unless a test shortens it. */
  readonly timeout?: Duration.Duration
  /** How long the running service gets to pause; 2 minutes unless a test shortens it. */
  readonly pause?: Duration.Duration
}

export const make = Effect.fn("upgrade.updater.make")(function* (options: Options) {
  const fs = yield* FileSystem.FileSystem
  const flock = yield* EffectFlock.Service
  const context = yield* Effect.context<FileSystem.FileSystem | AppProcess.Service | EffectFlock.Service>()
  const layout = ReleaseLayout.at(options.data, options.runners)
  const running = yield* Semaphore.make(1)

  const readPolicy = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
      fs.readFileString(path.join(options.config, name)).pipe(
        Effect.map(decodePolicy),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? "notify"
  })

  // The release this process may switch from, or why it cannot upgrade itself.
  const inspect = Effect.fnUntraced(function* () {
    if (options.local)
      return {
        type: "unavailable" as const,
        message: `This ${Product.name} runs from a source checkout. Install a release to upgrade it.`,
      }
    if (!options.platform)
      return {
        type: "unavailable" as const,
        message: `${Product.name} releases are built for ${Release.platforms.join(" and ")} only.`,
      }
    const own = yield* fs.realPath(ReleaseLayout.binary(layout, options.version)).pipe(Effect.option)
    const from = yield* ReleaseLayout.current(layout)
    if (Option.isNone(own) || own.value !== options.executable || !from)
      return {
        type: "unavailable" as const,
        message: `${Product.name} upgrades itself only when installed with install.sh into ${layout.releases}; this one runs from ${options.executable}.`,
      }
    if (yield* options.serviceDisabled)
      return {
        type: "unavailable" as const,
        message: `The background service is turned off, so every ${Product.name} runs its own server on the database and none can be switched. Turn it on with "${Product.binary} service unset disabled" to upgrade.`,
      }
    return { type: "installed" as const, from, platform: options.platform }
  })

  const target = Effect.fnUntraced(function* () {
    return {
      layout,
      database: options.database,
      service: yield* options.service,
      log: path.join(options.log, "upgrade.log"),
      timeout: options.timeout,
      pause: options.pause,
    } satisfies ReleaseSwitch.Target
  })

  const install = Effect.fnUntraced(function* (manifest: Release.Manifest, platform: Release.Platform) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* flock
          .acquire(installLock.key, layout.locks, { timeoutMs: Duration.toMillis(installLock.timeout) })
          .pipe(
            Effect.mapError(
              () => new UpgradeError({ reason: `another ${Product.name} process is still installing a release` }),
            ),
          )
        yield* ReleaseLayout.install({ layout, base: options.base, manifest, platform })
        const from = yield* ReleaseLayout.current(layout)
        yield* ReleaseLayout.prune(layout, [manifest.version, ...(from ? [from] : [])])
      }),
    )
  })

  // Which database the target release starts with: undefined keeps the current one.
  const database = Effect.fnUntraced(function* (
    switching: ReleaseSwitch.Target,
    input: { readonly from: string; readonly to: string; readonly restore: boolean },
  ) {
    const copy = ReleaseSwitch.copyOf(switching, input.to)
    if (input.restore) {
      if (yield* fs.exists(copy)) return copy
      return yield* new UpgradeError({
        reason: `there is no database copy from when ${Product.name} ${input.to} was left`,
      })
    }
    // A newer release migrates the database forward itself.
    if (!ReleaseVersion.newer(input.from, input.to)) return undefined
    const live = yield* ReleaseDatabase.migrations(switching.database)
    if (!live?.length) return undefined
    const known = yield* ReleaseDatabase.migrations(copy)
    if (!known)
      return yield* new UpgradeError({
        reason:
          `${Product.name} ${input.to} was never left on this machine, so there is no database copy that shows which ` +
          `database changes it knows; not switching, as it might not be able to read the current database`,
      })
    const unknown = live.filter((id) => !known.includes(id))
    if (unknown.length === 0) return undefined
    const at = (yield* ReleaseDatabase.madeAt(copy))?.toISOString() ?? "an unknown time"
    return yield* new UpgradeError({
      reason:
        `${Product.name} ${input.to} can't read the current database: newer releases changed its structure ` +
        `(${unknown.join(", ")}). The copy made when ${Product.name} ${input.to} was left, at ${at}, can be used ` +
        `instead, but it lacks everything stored since then: chats, messages and settings saved after ${at}. ` +
        `To switch with that copy: ${Product.binary} upgrade ${input.to} --restore-database`,
    })
  })

  const upgrade = Effect.fn("upgrade.updater.upgrade")(function* (input: UpgradeInput = {}) {
    const notify = input.notify ?? (() => {})
    const status = yield* inspect()
    if (status.type === "unavailable") return status
    const from = status.from
    const requested =
      input.target === undefined
        ? undefined
        : (ReleaseVersion.normalize(input.target) ??
          (yield* new UpgradeError({ reason: `not a version: ${input.target}` })))
    const kept = requested !== undefined && (yield* ReleaseLayout.installed(layout)).includes(requested)
    const manifest = kept ? undefined : yield* Release.manifest(options.base, requested ?? "latest")
    const to = requested ?? manifest?.version ?? from
    if (to === from || (requested === undefined && !ReleaseVersion.newer(to, from)))
      return { type: "current" as const, version: from }
    const bad = requested === undefined ? (yield* ReleaseLayout.bad(layout))[to] : undefined
    if (bad)
      return yield* new UpgradeError({
        reason: `${Product.name} ${to} failed to start before and was rolled back (${bad.reason}; log: ${bad.log}); run "${Product.binary} upgrade ${to}" to try it again`,
      })
    const switching = yield* target()
    const restore = yield* database(switching, { from, to, restore: input.restoreDatabase ?? false })
    // Every step from here on is in the upgrade log; a failed one leaves `from` in use.
    const failed = (reason: string) =>
      new UpgradeError({
        reason: `upgrade to ${to} failed: ${reason}; still on ${from}. Log: ${switching.log}`,
      })
    if (manifest) {
      notify({ type: "installing", version: to })
      yield* install(manifest, status.platform).pipe(
        Effect.tapError((error) => ReleaseSwitch.note(switching, { from, to }, `failed to install: ${error.message}`)),
        Effect.mapError((error) => failed(error.message)),
      )
    }
    // Switches at once; a pause that gave up, or a service that cannot pause, makes it try again later.
    const result = yield* Effect.gen(function* () {
      notify({ type: "switching", version: to })
      const outcome = yield* ReleaseSwitch.run(switching, {
        from,
        to,
        restore,
        onWaiting: (waiting) => notify({ type: "switching", version: to, waiting }),
      })
      if (outcome.type !== "busy") return outcome
      notify({ type: "waiting", version: to, expired: outcome.expired })
      yield* outcome.expired
        ? ReleaseSwitch.finished(switching, outcome.expired.waiting)
        : ReleaseSwitch.idle(switching)
      return outcome
    }).pipe(
      Effect.repeat({ until: (result) => result.type !== "busy" }),
      Effect.mapError((error) => failed(error.message)),
    )
    if (result.type === "rolled-back")
      return yield* failed(
        result.restored ? result.reason : `${result.reason} (${Product.name} ${from} did not start again either)`,
      )
    notify({ type: "switched", version: to })
    return { type: "switched" as const, from, to }
  })

  const startup = (notify: (state: UpgradeState) => void) =>
    Effect.gen(function* () {
      if (options.local || options.disabled) return
      const policy = yield* readPolicy()
      if (policy === "disable") return
      const status = yield* inspect()
      if (status.type === "unavailable")
        return yield* Effect.logInfo("upgrade check skipped", { reason: status.message })
      const latest = yield* Release.manifest(options.base, "latest")
      if (!ReleaseVersion.newer(latest.version, status.from)) return
      if ((yield* ReleaseLayout.bad(layout))[latest.version])
        return yield* Effect.logInfo("upgrade check skipped a release that failed before", { version: latest.version })
      yield* Effect.logInfo("openforge release available", { current: status.from, latest: latest.version, policy })
      if (policy === "notify") return notify({ type: "available", version: latest.version })
      // A check that could not run only goes to the log; an automatic upgrade that failed is shown.
      yield* upgrade({ notify }).pipe(
        Effect.tapError((error) => Effect.sync(() => notify({ type: "failed", message: error.message }))),
      )
    }).pipe(
      Effect.catch((error) => Effect.logWarning("upgrade check failed", { error })),
      Effect.withSpan("upgrade.updater.startup"),
    )

  return Service.of({
    current: () =>
      ReleaseLayout.current(layout).pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.provide(context),
      ),
    startup: (notify) => running.withPermits(1)(startup(notify)).pipe(Effect.provide(context)),
    upgrade: (input) =>
      running
        .withPermits(1)(upgrade(input))
        .pipe(
          Effect.tapError((error) => Effect.sync(() => input?.notify?.({ type: "failed", message: error.message }))),
          Effect.mapError((cause) =>
            cause instanceof UpgradeError ? cause : new UpgradeError({ reason: cause.message }),
          ),
          Effect.provide(context),
        ),
    switched: () => SwitchLock.wait(layout.locks).pipe(Effect.provide(context)),
  })
})

export function decodePolicy(text: string): Policy | undefined {
  // The CLI only projects this host-level preference instead of initializing
  // the location-scoped server configuration graph.
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null) return
  if ("update" in input) {
    const value = input.update
    if (value === "disable" || value === "notify" || value === "auto") return value
    return
  }
  if (!("autoupdate" in input)) return
  if (input.autoupdate === false) return "disable"
  if (input.autoupdate === "notify") return "notify"
  if (input.autoupdate === true) return "auto"
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const global = yield* Global.Service
    const context = yield* Effect.context<FileSystem.FileSystem | Global.Service>()
    return yield* make({
      data: global.data,
      runners: RunnerPaths.root(global.state),
      config: global.config,
      log: global.log,
      version: OPENCODE_VERSION,
      local: OPENCODE_LOCAL,
      disabled: ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? ""),
      executable: yield* fs.realPath(process.execPath).pipe(Effect.orElseSucceed(() => process.execPath)),
      platform: Release.platform(),
      base: Release.base(),
      database: databasePath(global.data),
      service: ServiceConfig.options().pipe(
        Effect.map((options) => ({ file: options.file, env: options.env, pty: "handoff" as const })),
        Effect.mapError(
          (cause) => new UpgradeError({ reason: `could not read the service configuration: ${cause.message}` }),
        ),
        Effect.provide(context),
      ),
      serviceDisabled: ServiceConfig.read().pipe(
        Effect.map((config) => config.disabled === true),
        Effect.orElseSucceed(() => false),
        Effect.provide(context),
      ),
    })
  }),
)

export * as Updater from "./updater"
