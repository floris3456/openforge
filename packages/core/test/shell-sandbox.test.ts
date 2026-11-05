import fs from "fs"
import path from "path"
import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
import { Sandbox } from "@opencode/sandbox"
import { TuiEvent } from "@opencode/schema/tui-event"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { SessionContinuity } from "@opencode/core/continuity"
import { Database } from "@opencode/core/database/database"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { Shell } from "@opencode/core/shell"
import { ShellSelect } from "@opencode/core/shell/select"
import { ShellWrap } from "@opencode/core/shell/wrap"
import { Tool } from "@opencode/core/tool"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

// The agent's shell commands through the real sandbox. Every temp folder is writable inside the sandbox, so the
// folders a command must not write to sit in this package instead.

const sessionID = Session.ID.make("ses_shell_sandbox")
const NOTE = "This command ran in the sandbox, which lets it write only to "
const self = [process.execPath, path.join(import.meta.dir, "fixture/sandbox-exec.ts")]
const state = { root: "" }

beforeAll(() => {
  state.root = fs.realpathSync(fs.mkdtempSync(path.join(import.meta.dir, ".sandbox-")))
})

afterAll(() => {
  if (state.root) fs.rmSync(state.root, { recursive: true, force: true })
})

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [],
})

const plugins = makeLocationNode({
  name: "test/shell-sandbox-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      // Its session hooks too, which say what the sandbox allows.
      yield* registerToolPlugin(ShellTool.Plugin, {
        session: { hook: (name, callback, options) => hooks.register("session", name, callback, options) },
      })
    }),
  ),
  deps: [
    PluginHooks.node,
    Config.node,
    Environment.node,
    FileAccess.node,
    Permission.node,
    Session.node,
    Job.node,
    Shell.node,
    ShellSelect.node,
    SessionContinuity.node,
    Tool.node,
  ],
})

const harness = (machine?: Sandbox.Availability) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        Job.node,
        Session.node,
        SessionExecution.node,
        LocationServiceMap.node,
        PermissionSaved.node,
        filesystem,
        FSUtil.node,
        Global.node,
      ]),
      [
        SessionExecution.node.replace(executionNode),
        Global.node.replace(tempGlobalLayer),
        PluginSupervisor.node.replace(plugins),
        ShellWrap.node.replace(ShellWrap.configured({ self, ...(machine ? { machine } : {}) })),
        offlineModels,
      ],
    ),
  )

/** A chat in a folder of its own, its `opencode.json` written first; the agent may do anything but leave the sandbox. */
const withChat = <A, E, R>(
  config: Record<string, unknown>,
  body: (registry: Tool.Interface, chat: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(tmp.path, "opencode.json"), JSON.stringify(config))
        const sessions = yield* Session.Service
        const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
        yield* sessions.create({
          id: sessionID,
          title: "sandbox",
          location,
          model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") }),
        })
        const locations = yield* LocationServiceMap.Service
        return yield* Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.awaitActivation
          const select = yield* ShellSelect.Service
          yield* select.transform((editor) => editor.configure("sh"))
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [
                { action: "*", resource: "*", effect: "allow" },
                { action: Sandbox.permission, resource: "*", effect: "ask" },
              ]
            }),
          )
          return yield* body(yield* Tool.Service, tmp.path)
        }).pipe(Effect.provide(locations.get(location)), Effect.ensuring(locations.invalidate(location)))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
  )

const call = (input: typeof ShellTool.Input.Type) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${crypto.randomUUID()}`, name: "shell", input },
})

const text = (result: { readonly content?: ReadonlyArray<Tool.Content> }) =>
  (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n")

/** The shell tool as a request of the test agent offers it to the model. */
const offered = (registry: Tool.Interface) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const shell = (yield* toolDefinitions(registry)).find((tool) => tool.name === "shell")
    if (!shell) throw new Error("the shell tool is missing")
    const event = yield* hooks.trigger("session", "context", {
      sessionID,
      model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") }),
      system: [],
      messages: [],
      options: {},
      agent: toolIdentity.agent,
      tools: { shell: { description: shell.description, input: structuredClone(shell.inputSchema) } },
    })
    return event.tools.shell
  })

const WRITE = "Commands run in a sandbox that lets them write only to the chat's folder"

/** A folder outside every place the sandbox lets a command write. */
const outside = () => fs.mkdtempSync(path.join(state.root, "outside-"))

/** Runs a call and answers the permission requests it asks with `replies`, in order. */
const answered = (registry: Tool.Interface, input: typeof ShellTool.Input.Type, replies: Permission.Reply[]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Queue.unbounded<Permission.Request>()
    yield* bus.subscribe(Permission.Event.Asked).pipe(
      Stream.runForEach((event) => Queue.offer(asked, event.data)),
      Effect.forkScoped({ startImmediately: true }),
    )
    const execution = yield* executeTool(registry, call(input)).pipe(Effect.forkScoped)
    const requests = yield* Effect.forEach(replies, (reply) =>
      Queue.take(asked).pipe(Effect.tap((request) => permission.reply({ requestID: request.id, reply }))),
    )
    return { exit: yield* Fiber.await(execution), requests }
  }).pipe(Effect.scoped, Effect.timeout("15 seconds"))

const it = harness()
const sandboxed = Sandbox.available().ok && process.platform !== "win32" ? it.live : it.live.skip

describe("the agent's shell commands in the sandbox", () => {
  sandboxed(
    "write in the chat's folder, are refused elsewhere, and a failed one's result says where it may write",
    () =>
      withChat({}, (registry, chat) =>
        Effect.gen(function* () {
          const inside = yield* executeTool(registry, call({ command: "touch inside" }))
          expect(inside).toMatchObject({ status: "completed", metadata: { exit: 0 } })
          expect(fs.existsSync(path.join(chat, "inside"))).toBe(true)
          expect(text(inside)).not.toContain(NOTE)

          const target = path.join(outside(), "refused")
          const refused = yield* executeTool(registry, call({ command: `touch '${target}'` }))
          expect(refused).toMatchObject({ status: "completed", metadata: { exit: 1 } })
          expect(fs.existsSync(target)).toBe(false)
          expect(text(refused)).toContain("Permission denied")
          expect(text(refused)).toContain(`Exited with code 1\n\n${NOTE}`)
          // The chat's folder comes first in the write list, shortened when it is under the home folder.
          const home = fs.realpathSync((yield* Global.Service).home)
          const folder = fs.realpathSync(chat)
          const shown = folder.startsWith(home + path.sep) ? path.join("~", path.relative(home, folder)) : folder
          expect(text(refused)).toContain(`${NOTE}${shown}, `)
          expect(text(refused)).toContain("`sandbox: false`")
        }),
      ),
  )

  sandboxed("the shell tool tells the model what the sandbox allows, the same until the settings change", () =>
    withChat({}, (registry) =>
      Effect.gen(function* () {
        const first = yield* offered(registry)
        expect(first.description).toContain(
          `${WRITE}, its git folders, the temp folder and the package caches, unless the config allows more.`,
        )
        expect(first.description).toContain("has to write elsewhere, run it again with `sandbox: false`")
        expect(first.input).toHaveProperty("properties.sandbox")
        expect(yield* offered(registry)).toEqual(first)

        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(toolIdentity.agent, (info) => {
            info.sandbox = { mode: "read", network: false }
          }),
        )
        const read = yield* offered(registry)
        expect(read.description).toContain(
          "Commands run in a sandbox that lets them write only to the temp folder, and gives them no network.",
        )
        expect(read.description).toContain("has to write elsewhere or use the network, run it again")
      }),
    ),
  )

  sandboxed("the config's write list and the agent's add up", () =>
    Effect.gen(function* () {
      const [config, agent, neither] = [outside(), outside(), outside()]
      yield* withChat({ sandbox: { write: [config] } }, (registry) =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (info) => {
              info.sandbox = { write: [agent] }
            }),
          )
          for (const folder of [config, agent, neither]) {
            const result = yield* executeTool(registry, call({ command: `touch '${path.join(folder, "file")}'` }))
            expect(result).toMatchObject({ status: "completed", metadata: { exit: folder === neither ? 1 : 0 } })
          }
          expect([config, agent, neither].map((folder) => fs.existsSync(path.join(folder, "file")))).toEqual([
            true,
            true,
            false,
          ])
        }),
      )
    }),
  )

  sandboxed(
    "`sandbox: false` asks for the unsandboxed permission with the command, and runs outside once allowed",
    () =>
      withChat({}, (registry) =>
        Effect.gen(function* () {
          const target = path.join(outside(), "allowed")
          const command = `touch '${target}'`
          const allowed = yield* answered(registry, { command, sandbox: false }, ["once"])
          expect(allowed.requests).toMatchObject([{ action: "unsandboxed", resources: [command], save: [command] }])
          expect(allowed.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
          expect(fs.existsSync(target)).toBe(true)
        }),
      ),
  )

  sandboxed("`sandbox: false` runs nothing when the permission is denied", () =>
    withChat({}, (registry) =>
      Effect.gen(function* () {
        const target = path.join(outside(), "denied")
        const denied = yield* answered(registry, { command: `touch '${target}'`, sandbox: false }, ["reject"])
        expect(denied.requests).toMatchObject([{ action: "unsandboxed" }])
        expect(Exit.isFailure(denied.exit)).toBe(true)
        expect(fs.existsSync(target)).toBe(false)
      }),
    ),
  )

  sandboxed("commands the user types (`!`) run outside the sandbox", () =>
    withChat({}, (registry) =>
      Effect.gen(function* () {
        const target = path.join(outside(), "typed")
        const agent = yield* executeTool(registry, call({ command: `touch '${target}'` }))
        expect(agent).toMatchObject({ metadata: { exit: 1 } })
        expect(fs.existsSync(target)).toBe(false)

        const sessions = yield* Session.Service
        yield* sessions.shell({ sessionID, command: `touch '${target}'` })
        expect(fs.existsSync(target)).toBe(true)
        expect(yield* sessions.inbox(sessionID)).toMatchObject([
          { type: "synthetic", payload: { metadata: { source: "shell", state: "completed", exit: 0 } } },
        ])
      }),
    ),
  )
})

describe("on a machine that can't sandbox", () => {
  const unable = harness({ ok: false, reason: "this kernel has no Landlock" })
  const posix = process.platform === "win32" ? unable.live.skip : unable.live

  posix("a command is refused when the sandbox is required, and otherwise runs unsandboxed with one warning", () =>
    withChat({ sandbox: { required: true } }, (registry) =>
      Effect.gen(function* () {
        // The model is told how to run a command at all.
        expect((yield* offered(registry)).description).toContain(
          "This machine can't sandbox commands: this kernel has no Landlock. The config requires the sandbox, so to run a command, run it again with `sandbox: false`",
        )
        const bus = yield* Bus.Service
        const toasts: string[] = []
        yield* bus.subscribe(TuiEvent.ToastShow).pipe(
          Stream.runForEach((event) => Effect.sync(() => toasts.push(event.data.message))),
          Effect.forkScoped({ startImmediately: true }),
        )
        const target = path.join(outside(), "file")
        const refused = yield* executeTool(registry, call({ command: `touch '${target}'` }))
        expect(refused).toMatchObject({
          status: "error",
          error: {
            message: expect.stringContaining(
              "This machine can't sandbox commands: this kernel has no Landlock. The command was not run, as sandbox.required is set.",
            ),
          },
        })
        expect(fs.existsSync(target)).toBe(false)

        // The agent's own setting is the last layer.
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(toolIdentity.agent, (info) => {
            info.sandbox = { required: false }
          }),
        )
        const results = yield* Effect.forEach([1, 2], () =>
          executeTool(registry, call({ command: `touch '${target}'` })),
        )
        expect(results).toMatchObject([
          { status: "completed", metadata: { exit: 0 } },
          { status: "completed", metadata: { exit: 0 } },
        ])
        expect(fs.existsSync(target)).toBe(true)
        yield* Effect.yieldNow
        expect(toasts).toEqual([
          "This machine can't sandbox commands: this kernel has no Landlock. Commands run unsandboxed.",
        ])
        expect((yield* offered(registry)).description).not.toContain("sandbox")
      }),
    ),
  )
})

describe("with the sandbox off", () => {
  const posix = process.platform === "win32" ? it.live.skip : it.live

  posix("the shell tool mentions no sandbox, offers no way out of one, and `sandbox: false` asks nothing", () =>
    withChat({ sandbox: { mode: "off" } }, (registry) =>
      Effect.gen(function* () {
        const shell = yield* offered(registry)
        expect(shell.description).not.toContain("sandbox")
        expect(shell.input).not.toHaveProperty("properties.sandbox")
        const target = path.join(outside(), "file")
        const ran = yield* answered(registry, { command: `touch '${target}'`, sandbox: false }, [])
        expect(ran.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
        expect(fs.existsSync(target)).toBe(true)
      }),
    ),
  )
})
