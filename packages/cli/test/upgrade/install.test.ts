import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { testEffect } from "../../../core/test/lib/effect"
import { ReleaseLayout } from "../../src/upgrade/layout"
import { Release } from "../../src/upgrade/release"
import { fakeBinary, layer, paths, publish, releaseServer, root } from "./fixture/fixture"

const it = testEffect(NodeServices.layer)

const install = (directory: string, base: string, version: string) =>
  Effect.gen(function* () {
    const manifest = yield* Release.manifest(base, version)
    return yield* ReleaseLayout.install({
      layout: ReleaseLayout.at(paths(directory).data),
      base,
      manifest,
      platform: "linux-x64",
    })
  }).pipe(Effect.provide(layer(directory)))

const failure = <A, E extends { message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  )

const leftovers = (directory: string) =>
  Effect.promise(() => fs.readdir(ReleaseLayout.at(paths(directory).data).releases).catch(() => []))

describe("release contract", () => {
  it.live("parses SHA256SUMS in text and binary mode", () =>
    Effect.sync(() => {
      const sha = "a".repeat(64)
      const sums = Release.sums(`${sha}  openforge-linux-x64.tar.gz\n${"B".repeat(64)} *release.json\nnot a line\n`)
      expect(sums.get("openforge-linux-x64.tar.gz")).toBe(sha)
      expect(sums.get("release.json")).toBe("b".repeat(64))
      expect(sums.size).toBe(2)
    }),
  )

  it.live("builds GitHub download URLs and lets OPENFORGE_RELEASE_URL replace them", () =>
    Effect.sync(() => {
      expect(Release.url(Release.base({}), "latest", "release.json")).toBe(
        "https://github.com/floris3456/openforge/releases/latest/download/release.json",
      )
      expect(Release.url(Release.base({}), "0.0.1", "SHA256SUMS")).toBe(
        "https://github.com/floris3456/openforge/releases/download/v0.0.1/SHA256SUMS",
      )
      expect(Release.base({ OPENFORGE_RELEASE_URL: "http://127.0.0.1:1234/releases/" })).toBe(
        "http://127.0.0.1:1234/releases",
      )
      expect(Release.platform("linux", "x64")).toBe("linux-x64")
      expect(Release.platform("darwin", "arm64")).toBe("darwin-arm64")
      expect(Release.platform("darwin", "x64")).toBeUndefined()
    }),
  )

  it.live("reads the latest release.json", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const server = yield* releaseServer(
        { "0.0.2": yield* Effect.promise(() => publish(directory, "0.0.2")) },
        "0.0.2",
      )
      const manifest = yield* Release.manifest(server.url, "latest")
      expect(manifest.version).toBe("0.0.2")
      expect(server.requests).toEqual(["/releases/latest/download/release.json"])
      expect(yield* failure(Release.manifest(server.url, "0.0.9"))).toContain("HTTP 404")
    }),
  )
})

describe("install", () => {
  it.live("downloads, verifies and keeps a release under releases/<version>", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const server = yield* releaseServer({ "0.0.2": yield* Effect.promise(() => publish(directory, "0.0.2")) })
      const binary = yield* install(directory, server.url, "0.0.2")
      expect(binary).toBe(path.join(paths(directory).data, "releases", "0.0.2", "openforge"))
      expect(yield* leftovers(directory)).toEqual(["0.0.2"])
      expect(server.requests).toEqual([
        "/releases/download/v0.0.2/release.json",
        "/releases/download/v0.0.2/SHA256SUMS",
        "/releases/download/v0.0.2/openforge-linux-x64.tar.gz",
      ])
      // An installed release is not downloaded again.
      yield* install(directory, server.url, "0.0.2")
      expect(server.requests.filter((request) => request.endsWith(".tar.gz"))).toHaveLength(1)
    }),
  )

  // macOS checks a binary on its first run from a path, again after it moved; a switch then starts it from where it
  // is kept, while the chats are held.
  it.live("runs the new binary once from where it is kept, after checking it where it was unpacked", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const runs = path.join(directory, "runs.log")
      const server = yield* releaseServer({
        "0.0.2": yield* Effect.promise(() => publish(directory, "0.0.2", { runs })),
      })
      const binary = yield* install(directory, server.url, "0.0.2")
      const lines = (yield* Effect.promise(() => fs.readFile(runs, "utf8"))).split("\n").filter(Boolean)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain(path.join(path.dirname(path.dirname(binary)), ".install-"))
      expect(lines[0]).toEndWith(" --version")
      expect(lines[1]).toBe(`${binary} --version`)
    }),
  )

  it.live("refuses an archive whose SHA-256 differs from release.json and SHA256SUMS", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const wrong = "0".repeat(64)
      const server = yield* releaseServer({
        "0.0.2": yield* Effect.promise(() =>
          publish(directory, "0.0.2", { manifestSha: () => wrong, sums: () => wrong }),
        ),
      })
      expect(yield* failure(install(directory, server.url, "0.0.2"))).toContain(`the release lists ${wrong}`)
      expect(yield* leftovers(directory)).toEqual([])
    }),
  )

  it.live("refuses a release whose release.json and SHA256SUMS disagree, before downloading it", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const server = yield* releaseServer({
        "0.0.2": yield* Effect.promise(() => publish(directory, "0.0.2", { sums: () => "1".repeat(64) })),
      })
      expect(yield* failure(install(directory, server.url, "0.0.2"))).toContain("disagree")
      expect(server.requests.some((request) => request.endsWith(".tar.gz"))).toBe(false)
      expect(yield* leftovers(directory)).toEqual([])
    }),
  )

  it.live("refuses an archive that holds more than the openforge binary", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const server = yield* releaseServer({
        "0.0.2": yield* Effect.promise(() => publish(directory, "0.0.2", { extra: true })),
      })
      expect(yield* failure(install(directory, server.url, "0.0.2"))).toContain('must hold only "openforge"')
      expect(yield* leftovers(directory)).toEqual([])
    }),
  )

  it.live("refuses a binary whose --version does not print the expected version", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const server = yield* releaseServer({
        "0.0.2": yield* Effect.promise(() => publish(directory, "0.0.2", { print: "0.0.1" })),
      })
      expect(yield* failure(install(directory, server.url, "0.0.2"))).toContain(
        'reports version "openforge v0.0.1", not 0.0.2',
      )
      expect(yield* leftovers(directory)).toEqual([])
    }),
  )

  it.live("replaces a kept binary that fails its version check, keeping the folder's database copy", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const layout = ReleaseLayout.at(paths(directory).data)
      yield* Effect.promise(() => fakeBinary(ReleaseLayout.binary(layout, "0.0.2"), "0.0.2", { print: "broken" }))
      yield* Effect.promise(() => fs.writeFile(path.join(layout.releases, "0.0.2", "opencode.db"), "copy"))
      const server = yield* releaseServer({ "0.0.2": yield* Effect.promise(() => publish(directory, "0.0.2")) })
      yield* install(directory, server.url, "0.0.2")
      expect(
        yield* Effect.promise(() => fs.readdir(path.join(layout.releases, "0.0.2")).then((names) => names.sort())),
      ).toEqual(["opencode.db", "openforge"])
      yield* ReleaseLayout.verify(ReleaseLayout.binary(layout, "0.0.2"), "0.0.2").pipe(Effect.provide(layer(directory)))
    }),
  )
})

describe("kept releases", () => {
  it.live("keeps the newest three, never current or the one being left", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const layout = ReleaseLayout.at(paths(directory).data)
      yield* Effect.promise(() =>
        Promise.all(
          ["0.0.1", "0.0.2", "0.0.3", "0.0.4", "0.0.5"].map((version) =>
            fakeBinary(ReleaseLayout.binary(layout, version), version),
          ),
        ),
      )
      const removed = yield* ReleaseLayout.prune(layout, ["0.0.1"]).pipe(Effect.provide(layer(directory)))
      expect(removed).toEqual(["0.0.2"])
      expect(yield* ReleaseLayout.installed(layout).pipe(Effect.provide(layer(directory)))).toEqual([
        "0.0.5",
        "0.0.4",
        "0.0.3",
        "0.0.1",
      ])
    }),
  )

  it.live("points current at a release with a relative link", () =>
    Effect.gen(function* () {
      const directory = yield* root
      const layout = ReleaseLayout.at(paths(directory).data)
      yield* Effect.promise(() => fs.mkdir(layout.data, { recursive: true }))
      yield* ReleaseLayout.point(layout, "0.0.1").pipe(Effect.provide(layer(directory)))
      yield* ReleaseLayout.point(layout, "0.0.2").pipe(Effect.provide(layer(directory)))
      expect(yield* Effect.promise(() => fs.readlink(layout.current))).toBe(path.join("releases", "0.0.2"))
      expect(yield* ReleaseLayout.current(layout).pipe(Effect.provide(layer(directory)))).toBe("0.0.2")
      expect(
        (yield* Effect.promise(() => fs.readdir(layout.data))).filter((name) => name.startsWith("current")),
      ).toEqual(["current"])
    }),
  )
})
