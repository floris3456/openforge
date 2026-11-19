import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Context, Deferred, Effect, Layer, Option } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { UsageLimits } from "@opencode/core/usage-limits"
import { Database } from "../src/database/database"
import { Bus } from "../src/bus"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// A shared (global) node that no root of the server's graph builds is built by the first Location whose graph needs
// it, in the memo map every Location shares. It is the same for every Location, so what it sees while it is built
// must be no Location's: a Bus subscription made then would hear only that Location, and its publishes would carry
// that Location's stamp. These tests boot Locations through the real LocationServiceMap and Instance graph.

class Shared extends Context.Service<Shared, { readonly id: number }>()("test/SharedNode") {}

/** What each build of the shared node found in its context. */
const builds: Array<{ readonly location: string | undefined; readonly config: boolean }> = []
const released = { done: Deferred.makeUnsafe<void>() }
let count = 0
const shared = makeGlobalNode({
  service: Shared,
  layer: Layer.effect(
    Shared,
    Effect.gen(function* () {
      const location = yield* Effect.serviceOption(Location.Service)
      builds.push({
        location: Option.getOrUndefined(location)?.directory,
        // A service of one of the Location graph's own nodes, built before this one.
        config: Option.isSome(yield* Effect.serviceOption(Config.Service)),
      })
      const done = released.done
      yield* Effect.addFinalizer(() => Deferred.succeed(done, undefined))
      return Shared.of({ id: ++count })
    }),
  ),
  deps: [],
})
/** Each Location's shared node, as its own services get it. */
const seen = new Map<string, number>()
const needsShared = makeLocationNode({
  name: "test/needs-shared",
  layer: Layer.effect(
    UsageLimits.Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const node = yield* Shared
      seen.set(location.directory, node.id)
      return UsageLimits.Service.of({ get: () => Effect.succeed(undefined) })
    }),
  ),
  deps: [Location.node, shared],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    UsageLimits.node.replace(needsShared),
  ]),
)

const folders = Effect.gen(function* () {
  builds.length = 0
  seen.clear()
  released.done = Deferred.makeUnsafe<void>()
  const tmp = yield* tmpdirScoped()
  const [home, project] = ["home", "project"].map((name) =>
    Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, name)) }),
  )
  yield* Effect.promise(() => Promise.all([fs.mkdir(home.directory), fs.mkdir(project.directory)]))
  return { home, project }
})

describe("a shared node built while a Location boots", () => {
  it.live("sees none of that Location's services, and is one for every Location", () =>
    Effect.gen(function* () {
      const { home, project } = yield* folders
      const locations = yield* LocationServiceMap.Service
      yield* Effect.void.pipe(Effect.provide(locations.get(home)))
      yield* Effect.void.pipe(Effect.provide(locations.get(project)))

      expect(builds).toEqual([{ location: undefined, config: false }])
      expect(seen.get(home.directory)).toBeDefined()
      expect(seen.get(project.directory)).toBe(seen.get(home.directory))
    }),
  )

  it.live("sees no Location when another Location's fiber starts the boot", () =>
    Effect.gen(function* () {
      const { home, project } = yield* folders
      const locations = yield* LocationServiceMap.Service
      const inHome = yield* Location.Service.pipe(Effect.provide(locations.get(home)))
      // With every Location closed the shared node goes, and the next boot builds it again.
      yield* locations.invalidate(home)
      yield* Deferred.await(released.done)
      // A fiber that still carries the closed Location's services (one it forked, say) boots the next one: the boot
      // takes in the context of the fiber that asks for it.
      yield* Effect.void.pipe(Effect.provide(locations.get(project)), Effect.provideService(Location.Service, inHome))

      expect(builds).toEqual([
        { location: undefined, config: false },
        { location: undefined, config: false },
      ])
      expect(seen.get(project.directory)).not.toBe(seen.get(home.directory))
    }),
  )
})
