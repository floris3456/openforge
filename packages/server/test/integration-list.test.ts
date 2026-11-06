import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

// Integration.list keeps an integration's Info until the integration or its connections change. Each location lists
// its own registrations, and a plugin reloaded in a running location shows in the next list.

// Two locations boot, then reload a plugin twice: about a second here, more on a loaded runner.
it.live(
  "each location lists its own config, and a reloaded plugin shows in the next list",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("opencode-integration-list-")
      const global = path.join(tmp.path, "global")
      const folders = [path.join(tmp.path, "a"), path.join(tmp.path, "b")] as const
      yield* Effect.promise(async () => {
        await fs.mkdir(global)
        for (const [index, folder] of folders.entries()) {
          await fs.mkdir(folder)
          const name = `Custom in ${index === 0 ? "a" : "b"}`
          await Bun.write(
            path.join(folder, "opencode.json"),
            JSON.stringify({ providers: { custom: { name, models: { chat: {} } } } }),
          )
        }
      })
      const context = yield* Layer.build(
        createRoutes({
          database: { path: ":memory:" },
          models: { fetch: false },
          fs: { filewatcher: false },
          config: { directory: global },
        }).pipe(Layer.provide(HttpServer.layerServices)),
      )
      const handler = Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(HttpEffect.toWebHandlerWith(context))
      const name = (folder: string, integrationID: string) =>
        Effect.promise(async () => {
          const url = new URL("/api/integration", "http://opencode.local")
          url.searchParams.set("location[directory]", folder)
          const response = await handler(new Request(url))
          expect(response.status).toBe(200)
          const body: { data: { id: string; name: string }[] } = await response.json()
          return body.data.find((integration) => integration.id === integrationID)?.name
        })
      const next = (folder: string, integrationID: string, expected: string) =>
        Effect.gen(function* () {
          const deadline = Date.now() + 10_000
          while ((yield* name(folder, integrationID)) !== expected && Date.now() < deadline)
            yield* Effect.sleep("10 millis")
          expect(yield* name(folder, integrationID)).toBe(expected)
        })

      expect(yield* name(folders[0], "custom")).toBe("Custom in a")
      expect(yield* name(folders[1], "custom")).toBe("Custom in b")
      expect(yield* name(folders[0], "custom")).toBe("Custom in a")

      // Registering a plugin again under its ID reloads it in every running location.
      const sdk = Context.get(context, SdkPlugins.Service)
      const plugin = (integrationName: string) =>
        Plugin.define({
          id: "integration-list-check",
          effect: (ctx) =>
            ctx.integration.transform((editor) =>
              editor.update("plugin-check", (integration) => (integration.name = integrationName)),
            ),
        })
      yield* sdk.register(plugin("Plugin one"))
      yield* next(folders[0], "plugin-check", "Plugin one")
      yield* next(folders[1], "plugin-check", "Plugin one")
      yield* sdk.register(plugin("Plugin two"))
      yield* next(folders[0], "plugin-check", "Plugin two")
      yield* next(folders[1], "plugin-check", "Plugin two")
      expect(yield* name(folders[0], "custom")).toBe("Custom in a")
      expect(yield* name(folders[1], "custom")).toBe("Custom in b")
    }),
  { timeout: 15_000 },
)
