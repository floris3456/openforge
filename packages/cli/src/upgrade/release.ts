// The release contract shared with `script/openforge/release.ts` and `script/openforge/install.sh`:
// every GitHub release of floris3456/openforge carries `release.json`, one `openforge-<platform>.tar.gz`
// per platform holding just the `openforge` binary, and `SHA256SUMS`.

import { Effect, Schema } from "effect"
import { ReleaseVersion } from "./version"

export const defaultBase = "https://github.com/floris3456/openforge/releases"
export const binary = "openforge"
export const platforms = ["linux-x64", "darwin-arm64"] as const
export type Platform = (typeof platforms)[number]

export class UpgradeError extends Schema.TaggedError<UpgradeError>()("UpgradeError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export const Asset = Schema.Struct({
  name: Schema.String,
  sha256: Schema.String,
})

export const Manifest = Schema.Struct({
  version: Schema.String,
  assets: Schema.Record(Schema.String, Asset),
})
export type Manifest = typeof Manifest.Type

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))

/** The releases URL; `OPENFORGE_RELEASE_URL` replaces GitHub's for tests and local release servers. */
export function base(env: Record<string, string | undefined> = process.env) {
  return (env.OPENFORGE_RELEASE_URL || defaultBase).replace(/\/+$/, "")
}

export function url(base: string, target: "latest" | string, name: string) {
  if (target === "latest") return `${base}/latest/download/${name}`
  return `${base}/download/v${target}/${name}`
}

export function platform(os: string = process.platform, arch: string = process.arch): Platform | undefined {
  return platforms.find((item) => item === `${os}-${arch}`)
}

/** Parses `sha256sum` output: `<sha256>  <file>` per line, `*<file>` in binary mode. */
export function sums(text: string) {
  return new Map(
    text.split("\n").flatMap((line) => {
      const match = line.trim().match(/^([0-9a-fA-F]{64}) [ *](.+)$/)
      return match ? [[match[2], match[1].toLowerCase()] as const] : []
    }),
  )
}

/** Fetches a release's `release.json`; `target` is `latest` or a version. */
export const manifest = Effect.fn("upgrade.release.manifest")(function* (base: string, target: "latest" | string) {
  const text = yield* fetchText(url(base, target, "release.json"), "the release information")
  const manifest = yield* decodeManifest(text).pipe(
    Effect.mapError(() => new UpgradeError({ reason: "The release information (release.json) is not valid." })),
  )
  const version = ReleaseVersion.normalize(manifest.version)
  if (!version)
    return yield* new UpgradeError({ reason: `The release information names an invalid version: ${manifest.version}` })
  if (target !== "latest" && version !== target)
    return yield* new UpgradeError({
      reason: `The release information for ${target} names version ${manifest.version}.`,
    })
  return { ...manifest, version }
})

/** The asset for `platform`, with its checksum confirmed by `SHA256SUMS`. */
export const asset = Effect.fn("upgrade.release.asset")(function* (
  base: string,
  manifest: Manifest,
  platform: Platform,
) {
  const asset = manifest.assets[platform]
  if (!asset) return yield* new UpgradeError({ reason: `openforge ${manifest.version} has no build for ${platform}.` })
  const expected = asset.sha256.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected))
    return yield* new UpgradeError({ reason: `release.json has an invalid SHA-256 for ${asset.name}.` })
  const listed = sums(yield* fetchText(url(base, manifest.version, "SHA256SUMS"), "SHA256SUMS")).get(asset.name)
  if (listed !== expected)
    return yield* new UpgradeError({
      reason: listed
        ? `SHA256SUMS and release.json disagree about the checksum of ${asset.name}.`
        : `SHA256SUMS does not list ${asset.name}.`,
    })
  return { name: asset.name, sha256: expected, url: url(base, manifest.version, asset.name) }
})

/** Streams `source` into `file` and returns its SHA-256. */
export const download = Effect.fn("upgrade.release.download")(function* (source: string, file: string) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(source, { signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const hasher = new Bun.CryptoHasher("sha256")
      const writer = Bun.file(file).writer()
      for await (const chunk of response.body) {
        hasher.update(chunk)
        writer.write(chunk)
      }
      await writer.end()
      return hasher.digest("hex")
    },
    catch: (cause) =>
      new UpgradeError({ reason: `Could not download ${source}: ${cause instanceof Error ? cause.message : cause}` }),
  })
})

function fetchText(source: string, what: string) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(source, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.text()
    },
    catch: (cause) =>
      new UpgradeError({
        reason: `Could not download ${what} from ${source}: ${cause instanceof Error ? cause.message : cause}`,
      }),
  })
}

export * as Release from "./release"
