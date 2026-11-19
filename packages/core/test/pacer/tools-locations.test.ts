import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer, SubscriptionRef } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionTable } from "@opencode/core/session/sql"
import { UsageLimits } from "@opencode/core/usage-limits"
import { SessionID } from "@opencode/schema/session-id"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "../../src/bus"
import { Database } from "../../src/database/database"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { catalogOf, endpointOf, fakeCpp, until } from "./fake-tools"

// PacerTools is one for every directory: no root of the service's graph builds it, so the first Location to boot does.
// Its chats leave its map when they are deleted, wherever that is. Booted here as `openforge serve` boots Locations,
// through the real LocationServiceMap and Instance graph; listing PacerTools in this graph's roots would build a second
// one at the root, which hears everything.

const endpointRef = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(undefined))
const catalogRef = Effect.runSync(SubscriptionRef.make<PacerModels.Catalog | undefined>(catalogOf(true)))
const endpoints = Layer.succeed(
  PacerEndpoint.Service,
  PacerEndpoint.Service.of({
    get: () => SubscriptionRef.get(endpointRef),
    changes: () => SubscriptionRef.changes(endpointRef),
  }),
)
const catalogs = Layer.succeed(
  PacerModels.Service,
  PacerModels.Service.of({
    get: () => SubscriptionRef.get(catalogRef),
    changes: () => SubscriptionRef.changes(catalogRef),
    refresh: () => Effect.void,
  }),
)
/** Each Location's PacerTools, as its own services get it. */
const seen = new Map<string, PacerTools.Interface>()
const needsTools = makeLocationNode({
  name: "test/needs-pacer-tools",
  layer: Layer.effect(
    UsageLimits.Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const tools = yield* PacerTools.Service
      seen.set(location.directory, tools)
      return UsageLimits.Service.of({ get: () => Effect.succeed(undefined) })
    }),
  ),
  deps: [Location.node, PacerTools.node],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, KV.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    PacerEndpoint.node.replace(endpoints),
    PacerModels.node.replace(catalogs),
    UsageLimits.node.replace(needsTools),
  ]),
)

const step = (sessionID: SessionID): PacerTools.ListInput => ({
  sessionID,
  model: "claude-haiku-5-5",
  agent: "build",
  codemode: true,
  step: true,
  continues: false,
})

describe("PacerTools across directories", () => {
  it.live("lets go of a chat deleted in a directory other than the first to boot", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      yield* SubscriptionRef.set(endpointRef, endpointOf(cpp.origin))
      const tmp = yield* tmpdirScoped()
      const [home, project] = ["home", "project"].map((name) =>
        Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, name)) }),
      )
      yield* Effect.promise(() => Promise.all([fs.mkdir(home.directory), fs.mkdir(project.directory)]))
      const { db } = yield* Database.Service
      const id = Project.ID.make(crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"))
      yield* db.insert(ProjectTable).values({ id, worktree: home.directory, sandboxes: [] }).run().pipe(Effect.orDie)
      const inHome = SessionID.make("ses_tools_locations_home")
      const inProject = SessionID.make("ses_tools_locations_project")
      for (const [sessionID, where] of [
        [inHome, home],
        [inProject, project],
      ] as const)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: id,
            slug: sessionID,
            directory: where.directory,
            title: "t",
            version: "t",
          })
          .run()
          .pipe(Effect.orDie)
      const locations = yield* LocationServiceMap.Service
      const bus = yield* Bus.Service
      // The person's home directory boots first, then the project's when its chat runs.
      yield* Effect.void.pipe(Effect.provide(locations.get(home)))
      yield* Effect.void.pipe(Effect.provide(locations.get(project)))
      const tools = seen.get(home.directory)!
      expect(seen.get(project.directory)).toBe(tools)
      yield* tools.list(step(inHome))
      yield* tools.list(step(inProject))
      expect(tools.held(inHome)).toBeDefined()
      expect(tools.held(inProject)).toBeDefined()

      // The project's chat is deleted in its directory, as a chat's own routes publish it; then the home's through a
      // route of no directory. One subscription hears both in order, so once the second is heard the first was too.
      yield* bus.publish(SessionEvent.Deleted, { sessionID: inProject }).pipe(Effect.provide(locations.get(project)))
      yield* bus.publish(SessionEvent.Deleted, { sessionID: inHome })
      yield* until("the home's chat let go", () => tools.held(inHome) === undefined)
      expect(tools.held(inProject)).toBeUndefined()
    }),
  )
})
