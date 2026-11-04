import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { testEffect } from "../../../core/test/lib/effect"
import { publish, releaseServer, root } from "./fixture/fixture"

const it = testEffect(NodeServices.layer)
const script = path.resolve(import.meta.dir, "../../../../script/openforge/install.sh")

// Runs install.sh with /bin/sh (dash on this machine) in a home of its own, without ~/.local/bin on PATH.
const run = (home: string, base: string, args: string[] = [], env: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const child = Bun.spawn(["/bin/sh", script, ...args], {
      env: {
        HOME: home,
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
        OPENFORGE_RELEASE_URL: base,
        TMPDIR: home,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  })

describe("install.sh", () => {
  it.live("installs the latest release into the layout and links ~/.local/bin/openforge", () =>
    Effect.gen(function* () {
      const home = yield* root
      const server = yield* releaseServer(
        {
          "0.0.1": yield* Effect.promise(() => publish(home, "0.0.1")),
          "0.0.2": yield* Effect.promise(() => publish(home, "0.0.2")),
        },
        "0.0.2",
      )
      const result = yield* run(home, server.url)
      expect(result.stderr).toBe("")
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("openforge 0.0.2 is installed")
      expect(result.stdout).toContain(`${home}/.local/bin is not on your PATH`)
      const data = path.join(home, ".local", "share", "openforge")
      expect(yield* Effect.promise(() => fs.readlink(path.join(data, "current")))).toBe("releases/0.0.2")
      expect(yield* Effect.promise(() => fs.readlink(path.join(home, ".local", "bin", "openforge")))).toBe(
        path.join(data, "current", "openforge"),
      )
      expect(yield* Effect.promise(() => fs.readdir(path.join(data, "releases")))).toEqual(["0.0.2"])
      const version = Bun.spawnSync([path.join(home, ".local", "bin", "openforge"), "--version"])
      expect(version.stdout.toString().trim()).toBe("openforge v0.0.2")
      expect(server.requests).toEqual([
        "/releases/latest/download/release.json",
        "/releases/download/v0.0.2/SHA256SUMS",
        "/releases/download/v0.0.2/openforge-linux-x64.tar.gz",
      ])

      // A given version, with XDG_DATA_HOME honoured and ~/.local/bin on PATH.
      const custom = path.join(home, "xdg-data")
      const again = yield* run(home, server.url, ["v0.0.1"], {
        XDG_DATA_HOME: custom,
        PATH: [path.join(home, ".local", "bin"), "/usr/bin", "/bin"].join(":"),
      })
      expect(again.code).toBe(0)
      expect(again.stdout).not.toContain("not on your PATH")
      expect(yield* Effect.promise(() => fs.readlink(path.join(custom, "openforge", "current")))).toBe("releases/0.0.1")
    }),
  )

  it.live("switches current with a rename when it reinstalls over another version", () =>
    Effect.gen(function* () {
      const home = yield* root
      const server = yield* releaseServer({
        "0.0.1": yield* Effect.promise(() => publish(home, "0.0.1")),
        "0.0.2": yield* Effect.promise(() => publish(home, "0.0.2")),
      })
      expect((yield* run(home, server.url, ["0.0.1"])).code).toBe(0)
      const second = yield* run(home, server.url, ["0.0.2"])
      expect(second.code).toBe(0)
      expect(second.stdout).toContain('It replaced openforge 0.0.1. Next time, run "openforge upgrade"')
      const data = path.join(home, ".local", "share", "openforge")
      expect(yield* Effect.promise(() => fs.readlink(path.join(data, "current")))).toBe("releases/0.0.2")
      // The old target was not moved into: releases/0.0.1 holds only its binary.
      expect(yield* Effect.promise(() => fs.readdir(path.join(data, "releases", "0.0.1")))).toEqual(["openforge"])
    }),
  )

  it.live("refuses a download whose SHA-256 does not match SHA256SUMS and leaves nothing installed", () =>
    Effect.gen(function* () {
      const home = yield* root
      const server = yield* releaseServer({
        "0.0.2": yield* Effect.promise(() => publish(home, "0.0.2", { sums: () => "0".repeat(64) })),
      })
      const result = yield* run(home, server.url, ["0.0.2"])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`SHA256SUMS lists ${"0".repeat(64)}`)
      const data = path.join(home, ".local", "share", "openforge")
      expect(yield* Effect.promise(() => fs.readdir(path.join(data, "releases")))).toEqual([])
      expect(yield* Effect.promise(() => fs.exists(path.join(data, "current")))).toBe(false)
      expect(yield* Effect.promise(() => fs.exists(path.join(home, ".local", "bin", "openforge")))).toBe(false)
    }),
  )

  it.live("refuses a binary that reports another version, and a missing release", () =>
    Effect.gen(function* () {
      const home = yield* root
      const server = yield* releaseServer({
        "0.0.2": yield* Effect.promise(() => publish(home, "0.0.2", { print: "0.0.1" })),
      })
      const wrong = yield* run(home, server.url, ["0.0.2"])
      expect(wrong.code).toBe(1)
      expect(wrong.stderr).toContain('reports "openforge v0.0.1", not 0.0.2')
      const missing = yield* run(home, server.url, ["0.0.9"])
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("could not download")
      expect(yield* Effect.promise(() => fs.exists(path.join(home, ".local", "share", "openforge", "current")))).toBe(
        false,
      )
    }),
  )
})
