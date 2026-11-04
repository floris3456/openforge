import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Shell } from "@opencode/core/shell"
import { Workspace } from "@opencode/core/workspace"
import { Global } from "@opencode/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { location, tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

it.live("eviction makes progress past an already-removed shell", () =>
  Effect.gen(function* () {
    const shell = yield* Shell.Service
    const removed = yield* shell.create({ shell: "/bin/sh", command: "sleep 30", timeout: 0 })
    yield* shell.remove(removed.id)
    expect((yield* shell.result(removed)).capture).toBeUndefined()

    const complete = Effect.gen(function* () {
      const info = yield* shell.create({ shell: "/bin/sh", command: "printf hello", timeout: 0 })
      yield* shell.wait(info.id)
      return info
    })
    const oldest = yield* complete
    // Exceed the 25-entry retention cap with the removed ID at the head of the exit order.
    yield* Effect.forEach(Array.from({ length: 25 }), () => complete, { discard: true })
    expect(yield* shell.get(oldest.id).pipe(Effect.flip)).toBeInstanceOf(Shell.NotFoundError)
    expect(yield* Effect.promise(() => Bun.file(oldest.file).exists())).toBe(false)

    const survivor = yield* complete
    expect(yield* shell.result(survivor)).toMatchObject({
      info: { status: "exited", exit: 0 },
      capture: { output: "hello", truncated: false },
    })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(Shell.node, [
        Location.node.replace(tempLocationLayer),
        Global.node.replace(tempGlobalLayer),
        Config.node.replace(Config.testLayer()),
        Environment.node.replace(hostEnvironmentLayer),
      ]),
    ),
  ),
)

it.live("does not inherit host process.env when creating a shell in a workspace-backed location", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    let capturedEnv: Record<string, string | undefined> | undefined
    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const info = yield* shell.create({ shell: "/bin/sh", command: "printf ok", timeout: 0 }, (invocation) =>
        Effect.sync(() => {
          capturedEnv = { ...invocation.env }
        }),
      )
      expect(yield* shell.result(info)).toMatchObject({
        info: { status: "exited" },
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  Location.Ref.make({
                    directory: AbsolutePath.make(tmp.path),
                    workspaceID: Workspace.ID.make("wrk_workspace"),
                  }),
                ),
              ),
            ),
          ),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(hostEnvironmentLayer),
        ]),
      ),
    )

    expect(process.env.PATH).toBeDefined()
    expect(capturedEnv).toEqual({
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
    })
  }),
)
