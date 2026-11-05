// The release contract that `script/openforge/release.ts` builds on and `script/openforge/install.sh` repeats in sh:
// every release on GitHub (`Product.repository`) carries `release.json` (`Manifest`), one archive per platform
// (`archive`) holding just the `openforge` binary, and `SHA256SUMS`.

import { Product } from "@opencode/schema/product"
import { Duration, Effect, Schema } from "effect"
import { errorMessage } from "../util/error"
import { ReleaseVersion } from "./version"

const defaultBase = `https://github.com/${Product.repository}/releases`
// Generous for a ~40 MB archive on a slow line, but a stalled download still ends.
const downloadTimeout = Duration.minutes(15)
const fetchTimeout = Duration.seconds(30)

export const platforms = ["linux-x64", "darwin-arm64"] as const
export type Platform = (typeof platforms)[number]

/** A failed upgrade; `reason` is a clause without a closing period, so it reads inside a longer message. */
export class UpgradeError extends Schema.TaggedError<UpgradeError>()("UpgradeError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export const Manifest = Schema.Struct({
  version: Schema.String,
  assets: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String, sha256: Schema.String })),
})
export type Manifest = typeof Manifest.Type

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))

/** The archive that holds `platform`'s build. */
export function archive(platform: Platform) {
  return `${Product.binary}-${platform}.tar.gz`
}

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
    Effect.mapError(() => new UpgradeError({ reason: "the release information (release.json) is not valid" })),
  )
  const version = ReleaseVersion.normalize(manifest.version)
  if (!version)
    return yield* new UpgradeError({ reason: `the release information names an invalid version: ${manifest.version}` })
  if (target !== "latest" && version !== target)
    return yield* new UpgradeError({
      reason: `the release information for ${target} names version ${manifest.version}`,
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
  if (!asset)
    return yield* new UpgradeError({ reason: `${Product.name} ${manifest.version} has no build for ${platform}` })
  const expected = asset.sha256.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected))
    return yield* new UpgradeError({ reason: `release.json has an invalid SHA-256 for ${asset.name}` })
  const listed = sums(yield* fetchText(url(base, manifest.version, "SHA256SUMS"), "SHA256SUMS")).get(asset.name)
  if (listed !== expected)
    return yield* new UpgradeError({
      reason: listed
        ? `SHA256SUMS and release.json disagree about the checksum of ${asset.name}`
        : `SHA256SUMS does not list ${asset.name}`,
    })
  return { name: asset.name, sha256: expected, url: url(base, manifest.version, asset.name) }
})

/** Streams `source` into `file` and returns its SHA-256. */
export const download = Effect.fn("upgrade.release.download")(function* (source: string, file: string) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(source, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Duration.toMillis(downloadTimeout))]),
      })
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
    catch: (cause) => new UpgradeError({ reason: `could not download ${source}: ${errorMessage(cause)}` }),
  })
})

function fetchText(source: string, what: string) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(source, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Duration.toMillis(fetchTimeout))]),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.text()
    },
    catch: (cause) => new UpgradeError({ reason: `could not download ${what} from ${source}: ${errorMessage(cause)}` }),
  })
}

export * as Release from "./release"
