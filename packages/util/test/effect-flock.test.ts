import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { EffectFlock } from "../src/effect-flock.js"
import { LayerNode } from "../src/effect/layer-node.js"
import { Global } from "../src/global.js"
import { Hash } from "../src/hash.js"

// Runs `body` with the lock service over a fresh folder, which it gets and which is removed afterwards.
async function withLocks(
  body: (flock: EffectFlock.Interface, root: string) => Effect.Effect<void, EffectFlock.LockError>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "effect-flock-held-"))
  const folder = (name: string) => path.join(root, "global", name)
  const global = Global.layerWith({
    home: root,
    data: folder("data"),
    cache: folder("cache"),
    config: folder("config"),
    state: folder("state"),
    bin: folder("bin"),
    log: folder("log"),
  })
  try {
    await Effect.runPromise(
      EffectFlock.Service.pipe(
        Effect.flatMap((flock) => body(flock, root)),
        Effect.provide(LayerNode.compile(EffectFlock.node, { replacements: [Global.node.replace(global)] })),
      ),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

const listing = (dir: string) => fs.readdir(dir).catch(() => undefined)

describe("EffectFlock.held", () => {
  test("is true while someone holds the lock and false once it is free, and writes nothing", () =>
    withLocks((flock, root) =>
      Effect.gen(function* () {
        const dir = path.join(root, "locks")
        expect(yield* flock.held("held:key", dir)).toBe(false)
        // Asking created no lock folder.
        expect(yield* Effect.promise(() => listing(dir))).toBeUndefined()
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* flock.acquire("held:key", dir)
            const before = yield* Effect.promise(() => listing(dir))
            expect(yield* flock.held("held:key", dir)).toBe(true)
            expect(yield* flock.held("held:other", dir)).toBe(false)
            expect(yield* Effect.promise(() => listing(dir))).toEqual(before)
          }),
        )
        expect(yield* flock.held("held:key", dir)).toBe(false)
        expect(yield* Effect.promise(() => listing(dir))).toEqual([])
      }),
    ))

  test("is false for a lock whose holder stopped refreshing it", () =>
    withLocks((flock, root) =>
      Effect.gen(function* () {
        const dir = path.join(root, "locks")
        const lockDir = path.join(dir, Hash.fast("held:stale") + ".lock")
        // A holder that died two minutes ago left its lock folder and heartbeat.
        yield* Effect.promise(async () => {
          await fs.mkdir(lockDir, { recursive: true })
          await fs.writeFile(path.join(lockDir, "heartbeat"), "")
          const old = new Date(Date.now() - 120_000)
          await fs.utimes(path.join(lockDir, "heartbeat"), old, old)
          await fs.utimes(lockDir, old, old)
        })
        expect(yield* flock.held("held:stale", dir)).toBe(false)
        // The same lock counts as held under a stale time longer than its age.
        expect(yield* flock.held("held:stale", dir, { staleMs: 600_000 })).toBe(true)
        // Nothing was broken or removed.
        expect(yield* Effect.promise(() => listing(lockDir))).toEqual(["heartbeat"])
      }),
    ))
})
