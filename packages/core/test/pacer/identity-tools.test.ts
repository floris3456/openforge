import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { PacerModels } from "@opencode/core/pacer/models"
import { Plugin } from "@opencode/core/plugin"
import { AbsolutePath } from "@opencode/core/schema"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Layer } from "effect"
import { Bus } from "../../src/bus"
import { Database } from "../../src/database/database"
import { Tool } from "../../src/tool"
import { initRepo } from "../fixture/git"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { toolDefinitions } from "../lib/tool"
import { catalogOf } from "../memory/fixture"

// No tool of any agent links, makes or changes an agent's identity (the workspace's spec docs/specs/agent-badges.md,
// sections 1 and 4): against a CLIProxyPacer that keeps identities, no tool definition openforge sends any agent
// mentions them. `/identity` is the TUI's alone.

const catalog = catalogOf(true, { identities: true, tools: true, reviewItems: true, reviewOwed: true, inspect: true })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    PacerModels.node.replace(
      makeGlobalNode({
        service: PacerModels.Service,
        layer: Layer.succeed(
          PacerModels.Service,
          PacerModels.Service.of({
            get: () => Effect.succeed(catalog),
            changes: () => Stream.make(catalog),
            refresh: () => Effect.void,
          }),
        ),
        deps: [],
      }),
    ),
  ]),
)

describe("agents' identities and the tools", () => {
  it.live("no tool definition of any agent mentions identities", () =>
    Effect.gen(function* () {
      const repo = (yield* tmpdirScoped("opencode-identity-tools-")).path
      yield* Effect.promise(() => initRepo(repo))
      const lists = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        const registry = yield* Tool.Service
        const agents = yield* Agent.Service
        return yield* Effect.forEach(yield* agents.list(), (agent) =>
          Effect.map(toolDefinitions(registry, agent.permissions), (definitions) => ({
            agent: String(agent.id),
            definitions,
          })),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(repo) }))),
      )
      expect(lists.map((list) => list.agent)).toContain("build")
      expect(lists.every((list) => list.definitions.length > 0)).toBe(true)
      for (const list of lists)
        for (const definition of list.definitions)
          expect({
            agent: list.agent,
            tool: definition.name,
            mentions: /identit/i.test(JSON.stringify(definition)),
          }).toEqual({
            agent: list.agent,
            tool: definition.name,
            mentions: false,
          })
    }),
  )
})
