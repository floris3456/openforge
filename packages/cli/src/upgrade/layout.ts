// The install layout shared with `script/openforge/install.sh`:
//   <data>/releases/<version>/openforge   every kept release
//   <data>/current -> releases/<version>  the release in use, swapped with one rename
//   ~/.local/bin/openforge -> <data>/current/openforge
// A release folder also holds the database copy made when openforge last switched away from it.

import { Product } from "@opencode/schema/product"
import { RunnerLock } from "@opencode/runner/lock"
import { RunnerPaths } from "@opencode/runner/paths"
import { AppProcess } from "@opencode/util/process"
import { Effect, FileSystem, Option, Schema } from "effect"
import { ChildProcess } from "effect/process"
import path from "node:path"
import { Release, UpgradeError } from "./release"
import { SwitchLock } from "./switch-lock"
import { ReleaseVersion } from "./version"

// How many releases stay installed.
const keep = 3
// How long the new binary's version check and the archive's tar may run, and how much they may print.
const versionRun = { timeout: "30 seconds", maxOutputBytes: 10_000, maxErrorBytes: 10_000 } as const
const tarRun = { timeout: "2 minutes", maxOutputBytes: 100_000 } as const

export type Layout = {
  readonly data: string
  readonly releases: string
  readonly current: string
  readonly locks: string
  readonly state: string
  /** The releases' tool runner folders (`RunnerPaths.root`); a release whose runner still runs is kept. */
  readonly runners: string | undefined
}

export function at(data: string, runners?: string): Layout {
  return {
    data,
    releases: path.join(data, "releases"),
    current: path.join(data, "current"),
    locks: SwitchLock.directory(data),
    state: path.join(data, "upgrade.json"),
    runners,
  }
}

export function folder(layout: Layout, version: string) {
  return path.join(layout.releases, version)
}

export function binary(layout: Layout, version: string) {
  return path.join(folder(layout, version), Product.binary)
}

/** The version `current` points at, or undefined when openforge was not installed into this layout. */
export const current = Effect.fn("upgrade.layout.current")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem
  const target = yield* fs.readLink(layout.current).pipe(Effect.option)
  if (Option.isNone(target)) return undefined
  return ReleaseVersion.normalize(path.basename(target.value))
})

/** Kept releases that have a binary, newest first. */
export const installed = Effect.fn("upgrade.layout.installed")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(layout.releases).pipe(Effect.orElseSucceed(() => []))
  const present = yield* Effect.filter(names, (name) =>
    ReleaseVersion.normalize(name) === name ? fs.exists(binary(layout, name)) : Effect.succeed(false),
  )
  return ReleaseVersion.newestFirst(present)
})

/** Points `current` at `version` with one atomic rename. */
export const point = Effect.fn("upgrade.layout.point")(function* (layout: Layout, version: string) {
  const fs = yield* FileSystem.FileSystem
  const temporary = `${layout.current}.${process.pid}.${Date.now()}`
  yield* fs.remove(temporary, { force: true })
  yield* fs.symlink(path.join("releases", version), temporary)
  yield* fs
    .rename(temporary, layout.current)
    .pipe(Effect.tapError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)))
})

/** Releases whose tool runner still runs: their binary still runs commands. */
export const running = Effect.fn("upgrade.layout.running")(function* (layout: Layout) {
  const runners = layout.runners
  if (!runners) return []
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(runners).pipe(Effect.orElseSucceed(() => []))
  const live = yield* Effect.filter(names, (name) =>
    Effect.promise(() => RunnerLock.held(RunnerPaths.lock(path.join(runners, name)))),
  )
  return live.flatMap((name) => ReleaseVersion.normalize(name) ?? [])
})

/**
 * Removes all but the newest `keep` releases, never one in `protect` nor one whose tool runner still runs. Returns
 * the removed versions.
 */
export const prune = Effect.fn("upgrade.layout.prune")(function* (layout: Layout, protect: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const kept = [...protect, ...(yield* running(layout))]
  const removed = (yield* installed(layout)).slice(keep).filter((version) => !kept.includes(version))
  yield* Effect.forEach(removed, (version) => fs.remove(folder(layout, version), { recursive: true, force: true }))
  return removed
})

/** Runs `file --version` and requires it to print `version` (as `openforge v<version>` or bare). */
export const verify = Effect.fn("upgrade.layout.verify")(function* (file: string, version: string) {
  const appProcess = yield* AppProcess.Service
  const result = yield* appProcess
    .run(ChildProcess.make(file, ["--version"]), versionRun)
    .pipe(
      Effect.mapError(
        (cause) => new UpgradeError({ reason: `the new ${Product.name} binary did not run: ${cause.message}` }),
      ),
    )
  const printed = result.stdout.toString("utf8").trim()
  const reported = ReleaseVersion.normalize(printed.split(/\s+/).at(-1) ?? "")
  if (result.exitCode === 0 && reported === version) return
  return yield* new UpgradeError({
    reason:
      result.exitCode === 0
        ? `the new ${Product.name} binary reports version "${printed}", not ${version}`
        : `the new ${Product.name} binary failed its version check (exit ${result.exitCode}): ${result.stderr.toString("utf8").trim() || printed}`,
  })
})

/**
 * Downloads `manifest`'s build for `platform` into a temporary folder, checks its SHA-256 against release.json and
 * SHA256SUMS, unpacks it and runs its `--version`. Only then does it become `releases/<version>/openforge`.
 */
export const install = Effect.fn("upgrade.layout.install")(function* (input: {
  readonly layout: Layout
  readonly base: string
  readonly manifest: Release.Manifest
  readonly platform: Release.Platform
}) {
  const fs = yield* FileSystem.FileSystem
  const version = input.manifest.version
  const target = binary(input.layout, version)
  const existing = yield* verify(target, version).pipe(Effect.option)
  if (Option.isSome(existing)) return target
  const asset = yield* Release.asset(input.base, input.manifest, input.platform)
  yield* fs.makeDirectory(input.layout.releases, { recursive: true })
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({ directory: input.layout.releases, prefix: `.install-` })
      const archive = path.join(temporary, asset.name)
      const sha256 = yield* Release.download(asset.url, archive)
      if (sha256 !== asset.sha256)
        return yield* new UpgradeError({
          reason: `the SHA-256 of the downloaded ${asset.name} is ${sha256}; the release lists ${asset.sha256}`,
        })
      const unpacked = path.join(temporary, "unpacked")
      yield* fs.makeDirectory(unpacked)
      const file = yield* unpack(archive, unpacked)
      yield* fs.chmod(file, 0o755)
      yield* verify(file, version)
      yield* fs.makeDirectory(folder(input.layout, version), { recursive: true })
      yield* fs.rename(file, target)
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof UpgradeError
        ? cause
        : new UpgradeError({ reason: `could not install ${Product.name} ${version}: ${cause.message}` }),
    ),
  )
  // macOS checks a binary the first time it runs from a path, again once it has moved: about 1.5 s for openforge.
  // Running it once from where it stays does that now, not while a switch holds the chats for its service to start.
  yield* verify(target, version)
  return target
})

// The archive must hold exactly one regular file, `openforge`, at its top level.
const unpack = Effect.fnUntraced(function* (archive: string, directory: string) {
  const fs = yield* FileSystem.FileSystem
  const appProcess = yield* AppProcess.Service
  const tar = (args: string[]) =>
    appProcess.run(ChildProcess.make("tar", args), tarRun).pipe(
      Effect.flatMap(AppProcess.requireSuccess),
      Effect.mapError(
        (cause) => new UpgradeError({ reason: `could not unpack ${path.basename(archive)}: ${cause.message}` }),
      ),
    )
  const entries = (yield* tar(["-tzf", archive])).stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter((line) => line && line !== "." && line !== "./")
  if (entries.length !== 1 || entries[0] !== Product.binary)
    return yield* new UpgradeError({
      reason: `${path.basename(archive)} must hold only "${Product.binary}"; it holds ${entries.join(", ") || "nothing"}`,
    })
  yield* tar(["-xzf", archive, "-C", directory])
  const file = path.join(directory, Product.binary)
  const info = yield* fs.lstat(file).pipe(Effect.option)
  if (Option.isNone(info) || info.value.type !== "File")
    return yield* new UpgradeError({
      reason: `"${Product.binary}" in ${path.basename(archive)} is not a regular file`,
    })
  return file
})

const Bad = Schema.Struct({ reason: Schema.String, log: Schema.String, at: Schema.String })
const State = Schema.Struct({ bad: Schema.optional(Schema.Record(Schema.String, Bad)) })
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(State))

/** Releases whose switch failed and was rolled back. openforge does not try them again on its own. */
export const bad = Effect.fn("upgrade.layout.bad")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(layout.state).pipe(Effect.option)
  return Option.getOrUndefined(Option.flatMap(text, decodeState))?.bad ?? {}
})

export const markBad = Effect.fn("upgrade.layout.mark-bad")(function* (
  layout: Layout,
  version: string,
  info: { readonly reason: string; readonly log: string },
) {
  yield* writeBad(layout, { ...(yield* bad(layout)), [version]: { ...info, at: new Date().toISOString() } })
})

export const clearBad = Effect.fn("upgrade.layout.clear-bad")(function* (layout: Layout, version: string) {
  const existing = yield* bad(layout)
  if (!(version in existing)) return
  const { [version]: _cleared, ...rest } = existing
  yield* writeBad(layout, rest)
})

const writeBad = Effect.fnUntraced(function* (layout: Layout, value: Record<string, typeof Bad.Type>) {
  const fs = yield* FileSystem.FileSystem
  const temporary = `${layout.state}.${process.pid}.tmp`
  yield* fs.makeDirectory(layout.data, { recursive: true })
  yield* fs.writeFileString(temporary, JSON.stringify({ bad: value }, null, 2) + "\n")
  yield* fs.rename(temporary, layout.state)
})

export * as ReleaseLayout from "./layout"
