import { expect } from "bun:test"
import path from "path"
import { SessionContinuity } from "@opencode/core/continuity"
import { ShellRunner } from "@opencode/core/shell/runner"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

// A Session execution that the shutdown interrupts can still be settling a call through the tool runner: one the user
// stopped just before waits for its command's exit there (continuity-shell.test.ts, "a user interrupt of the turn").
// Released first, the runner would never deliver that exit and the shutdown would hang.
it.live("releases the tool runner after the Session executions", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-release-order-")
    const folder = (name: string) => path.join(tmp.path, name)
    // Whether the executions had begun releasing, which marks the stop (SessionExecution's first finalizer), by the
    // time the runner releases.
    let stopped: boolean | undefined
    const runner = makeGlobalNode({
      service: ShellRunner.Service,
      layer: Layer.effect(
        ShellRunner.Service,
        Effect.gen(function* () {
          const continuity = yield* SessionContinuity.Service
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              stopped = continuity.stopping()
            }),
          )
          return yield* ShellRunner.Service
        }),
      ),
      deps: [ShellRunner.configured(), SessionContinuity.node],
    })
    yield* Layer.build(
      createRoutes(
        {
          database: { path: ":memory:" },
          models: { fetch: false },
          fs: { filewatcher: false },
          config: { directory: folder("config"), project: false },
        },
        () => [],
        [
          // The runner looks for the runners of earlier releases in the machine's state folder: a fresh one here.
          Global.node.replace(
            Global.layerWith({
              data: folder("data"),
              cache: folder("cache"),
              config: folder("config"),
              state: folder("state"),
              tmp: folder("tmp"),
              bin: folder("bin"),
              log: folder("log"),
              repos: folder("repos"),
            }),
          ),
          ShellRunner.node.replace(runner),
        ],
      ).pipe(Layer.provide(HttpServer.layerServices)),
    ).pipe(Effect.scoped)
    expect(stopped).toBe(true)
  }),
)
