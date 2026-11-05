import fs from "fs"
import path from "path"
import { Effect, Layer } from "effect"
import { RunnerClient } from "@opencode/runner/client"
import { RunnerServer } from "@opencode/runner/server"
import { App } from "@opencode/core/app"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Shell } from "@opencode/core/shell"
import { ShellRunner } from "@opencode/core/shell/runner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { until } from "../../../runner/test/fixture/runner"
import { hostEnvironmentLayer } from "./environment"
import { location } from "./location"
import { tmpdirScoped } from "./tmpdir"

export { alive } from "../../../runner/test/fixture/runner"

/** Waits for `condition` without a fixed sleep; fails, naming `what`, after 15 s. */
export const eventually = (condition: () => boolean, what?: string) => Effect.promise(() => until(condition, what))

/** How long a test's runner waits for another command once nothing runs, instead of the real 10 s. */
const GRACE = 200

/**
 * One machine whose tool runners outlive the services that start commands in them, as `openforge runner` does.
 * `service()` builds the shell services of one service process; build it again for the next one.
 */
export const machine = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const root = (name: string) => path.join(tmp.path, name)
  const project = root("project")
  fs.mkdirSync(project)
  const runners: RunnerServer.Runner[] = []
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => Promise.all(runners.map((runner) => runner.shutdown())).then(() => undefined)),
  )
  const hosted = (directory: string) =>
    Effect.tryPromise({
      try: () =>
        RunnerServer.serve({ directory, version: path.basename(directory), grace: GRACE }).then(
          (runner) => void runners.push(runner),
        ),
      catch: (cause) => new RunnerClient.RunnerError({ reason: "spawn", message: String(cause) }),
    })
  // The runner as its own process, so it can die on its own.
  const process_ = (directory: string) =>
    RunnerClient.launch([process.execPath, path.join(import.meta.dir, "runner-process.ts"), directory], directory)
  const global = Global.layerWith({
    data: root("data"),
    cache: root("cache"),
    config: root("config"),
    state: root("state"),
    tmp: root("tmp"),
    bin: root("bin"),
    log: root("log"),
    repos: root("repos"),
  })
  const ref = Location.Ref.make({ directory: AbsolutePath.make(project) })
  const service = (
    options: { readonly version?: string; readonly separate?: boolean; readonly location?: Location.Ref } = {},
  ) =>
    AppNodeBuilder.build(LayerNode.group([Shell.node, ShellRunner.node, Global.node]), [
      Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location(options.location ?? ref)))),
      Global.node.replace(global),
      Config.node.replace(Config.testLayer()),
      Environment.node.replace(hostEnvironmentLayer),
      App.node.replace(App.configured({ version: options.version ?? "test" })),
      ShellRunner.node.replace(ShellRunner.configured({ launch: options.separate ? process_ : hosted })),
    ])
  return {
    tmp: tmp.path,
    project,
    ref,
    runners,
    global,
    service,
    state: root("state"),
    launch: hosted,
    launchSeparate: process_,
  }
})
