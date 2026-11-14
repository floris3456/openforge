import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { KV } from "@opencode/core/kv"
import { MemoryKnown } from "@opencode/core/memory/known"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"
import { catalogOf } from "./fixture"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([KV.node, Database.node])))

// Synthetic: no real address or key.
const home = PacerEndpoint.resolve({ baseURL: "http://127.0.0.1:1/v1", apiKey: "k" }, undefined)!
const moved: PacerEndpoint.Endpoint = {
  ...home,
  origin: "http://127.0.0.1:2",
  root: "http://127.0.0.1:2",
  baseURL: "http://127.0.0.1:2/v1",
  home: home.root,
}
const other = PacerEndpoint.resolve({ baseURL: "http://127.0.0.1:3/v1", apiKey: "k" }, undefined)!

describe("MemoryKnown", () => {
  it.effect("what the set-up address said holds at another address of its pair, not at another server", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      yield* MemoryKnown.write(kv, home, catalogOf(true))
      expect(yield* MemoryKnown.read(kv, moved)).toBe(true)
      expect(yield* MemoryKnown.read(kv, other)).toBe(false)
      // Read at the moved endpoint, the answer is the pair's.
      yield* MemoryKnown.write(kv, moved, catalogOf(false))
      expect(yield* MemoryKnown.read(kv, home)).toBe(false)
    }),
  )
})
