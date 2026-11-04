// openforge's self-upgrade: one install method (GitHub releases, see ./release.ts), checked once at startup and
// on `/update` or `openforge upgrade`; never on a timer.

import { RunnerPaths } from "@opencode/runner/paths"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Context, Duration, Effect, FileSystem, Layer, Semaphore } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import { databasePath } from "../database-path"
import { ServiceConfig } from "../services/service-config"
import { OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { ReleaseDatabase } from "./database"
import { ReleaseLayout } from "./layout"
import { Release, UpgradeError } from "./release"
import { ReleaseSwitch } from "./switch"
import { ReleaseVersion } from "./version"

export { UpgradeError } from "./release"

export type Policy = "disable" | "notify" | "auto"

/** What an upgrade in progress reports, in order: installing, ready (only while a chat runs), switching, then switched or failed. */
export type State =
  | { readonly type: "available"; readonly version: string }
  | { readonly type: "installing"; readonly version: string }
  | { readonly type: "ready"; readonly version: string }
  | { readonly type: "switching"; readonly version: string }
  | { readonly type: "switched"; readonly version: string }
  | { readonly type: "failed"; readonly version?: string; readonly message: string }

export type Outcome =
  | { readonly type: "current"; readonly version: string }
  | { readonly type: "unavailable"; readonly message: string }
  | { readonly type: "switched"; readonly from: string; readonly to: string }

export type UpgradeInput = {
  /** A version to switch to, kept or downloaded; the latest release when omitted. */
  readonly target?: string
  /** Use the database copy made when `target` was left instead of the current database. */
  readonly restoreDatabase?: boolean
  readonly notify?: (state: State) => void
}

export interface Interface {
  /** The release `current` points at, when this openforge runs from the install layout. */
  readonly current: () => Effect.Effect<string | undefined>
  /** Once at startup: tells about (`notify`) or switches to (`auto`) a newer release. Never fails. */
  readonly startup: (notify: (state: State) => void) => Effect.Effect<void>
  /** Installs a release and switches to it once no chat is running, whatever the policy. */
  readonly upgrade: (input?: UpgradeInput) => Effect.Effect<Outcome, UpgradeError>
}

export class Service extends Context.Service<Service, Interface>()("@openforge/cli/Updater") {}

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
  /** How long a started service gets to answer; 10 s unless a test shortens it. */
  readonly timeout?: Duration.Duration
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
        message: "This openforge runs from a source checkout. Install a release to upgrade it.",
      }
    if (!options.platform)
      return {
        type: "unavailable" as const,
        message: `openforge releases are built for ${Release.platforms.join(" and ")} only.`,
      }
    const own = yield* fs.realPath(ReleaseLayout.binary(layout, options.version)).pipe(Effect.option)
    const from = yield* ReleaseLayout.current(layout)
    if (own._tag === "None" || own.value !== options.executable || !from)
      return {
        type: "unavailable" as const,
        message: `openforge upgrades itself only when installed with install.sh into ${layout.releases}; this one runs from ${options.executable}.`,
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
    } satisfies ReleaseSwitch.Target
  })

  const install = Effect.fnUntraced(function* (manifest: Release.Manifest, platform: Release.Platform) {
    // Several TUIs may install the same release at startup; one downloads, the others find it installed.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* flock
          .acquire(`openforge-release-install`, layout.locks, { timeoutMs: Duration.toMillis("15 minutes") })
          .pipe(
            Effect.mapError(
              () => new UpgradeError({ reason: "Another openforge process is still installing a release." }),
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
      return yield* new UpgradeError({ reason: `There is no database copy from when openforge ${input.to} was left.` })
    }
    // A newer release migrates the database forward itself.
    if (!ReleaseVersion.newer(input.from, input.to)) return undefined
    const live = yield* ReleaseDatabase.migrations(switching.database)
    if (!live?.length) return undefined
    const known = yield* ReleaseDatabase.migrations(copy)
    if (!known)
      return yield* new UpgradeError({
        reason:
          `openforge ${input.to} was never left on this machine, so there is no database copy that shows which ` +
          `database changes it knows. Not switching: it might not be able to read the current database.`,
      })
    const unknown = live.filter((id) => !known.includes(id))
    if (unknown.length === 0) return undefined
    const at = (yield* ReleaseDatabase.madeAt(copy))?.toISOString() ?? "an unknown time"
    return yield* new UpgradeError({
      reason:
        `openforge ${input.to} can't read the current database: newer releases changed its structure ` +
        `(${unknown.join(", ")}). The copy made when openforge ${input.to} was left, at ${at}, can be used instead, ` +
        `but it lacks everything stored since then: chats, messages and settings saved after ${at}. ` +
        `To switch with that copy: openforge upgrade ${input.to} --restore-database`,
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
          (yield* new UpgradeError({ reason: `Not a version: ${input.target}` })))
    const kept = requested !== undefined && (yield* ReleaseLayout.installed(layout)).includes(requested)
    const manifest = kept ? undefined : yield* Release.manifest(options.base, requested ?? "latest")
    const to = requested ?? manifest?.version ?? from
    if (to === from || (requested === undefined && !ReleaseVersion.newer(to, from)))
      return { type: "current" as const, version: from }
    const bad = requested === undefined ? (yield* ReleaseLayout.bad(layout))[to] : undefined
    if (bad)
      return yield* new UpgradeError({
        reason: `openforge ${to} failed to start before and was rolled back (${bad.reason}; log: ${bad.log}). Run "openforge upgrade ${to}" to try it again.`,
      })
    const switching = yield* target()
    const restore = yield* database(switching, { from, to, restore: input.restoreDatabase ?? false })
    // Every step from here on is in the upgrade log; a failed one leaves `from` in use.
    const failed = (reason: string) =>
      new UpgradeError({
        reason: `upgrade to ${to} failed: ${reason.replace(/\.$/, "")}; still on ${from}. Log: ${switching.log}`,
      })
    if (manifest) {
      notify({ type: "installing", version: to })
      yield* install(manifest, status.platform).pipe(
        Effect.tapError((error) => ReleaseSwitch.note(switching, { from, to }, `failed to install: ${error.message}`)),
        Effect.mapError((error) => failed(error.message)),
      )
    }
    const result = yield* Effect.gen(function* () {
      yield* ReleaseSwitch.idle(switching, () => notify({ type: "ready", version: to }))
      notify({ type: "switching", version: to })
      return yield* ReleaseSwitch.run(switching, { from, to, busy: ReleaseSwitch.busy(switching), restore })
    }).pipe(
      Effect.repeat({ until: (result) => result.type !== "busy" }),
      Effect.mapError((error) => failed(error.message)),
    )
    if (result.type === "rolled-back")
      return yield* failed(
        result.restored ? result.reason : `${result.reason} (openforge ${from} did not start again either)`,
      )
    notify({ type: "switched", version: to })
    return { type: "switched" as const, from, to }
  })

  const startup = (notify: (state: State) => void) =>
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
        Effect.map((options) => ({ file: options.file, env: options.env })),
        Effect.mapError(
          (cause) => new UpgradeError({ reason: `Could not read the service configuration: ${cause.message}` }),
        ),
        Effect.provide(context),
      ),
    })
  }),
)

export * as Updater from "./updater"
