import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { FileMutation } from "@opencode/core/file-mutation"
import { Formatter } from "@opencode/core/formatter"
import { Location } from "@opencode/core/location"
import { MemoryClient } from "@opencode/core/memory/client"
import { Model } from "@opencode/core/model"
import { Money } from "@opencode/schema/money"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { Permission } from "@opencode/core/permission"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { TaskFilesPlugin } from "@opencode/core/plugin/task-files"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { EditTool } from "@opencode/core/tool/plugin/edit"
import { PatchTool } from "@opencode/core/tool/plugin/patch"
import { WriteTool } from "@opencode/core/tool/plugin/write"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "../lib/tool"
import { catalogOf, endpointAt } from "../memory/fixture"

// The files report (workspace reference `docs/reference/task-system-later-api.md`, "Edited files and the clash
// notice"): after each successful edit, write or patch of a chat whose latest step went through CLIProxyPacer, on a
// server with memory `later`, while the chat is inside a task, openforge posts the call's paths and appends CPP's notice
// to the tool's result; it waits at most 500 ms, and a timeout or failure adds nothing. The real file tools run in a
// folder of the file's own, through the real tool registry and its hooks; CPP is a small server of the test's own.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-files-")))
const PROJECT = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"

type Received = { path: string; body: { paths: string[]; at: number }; session: string | null; agent: string | null }
const received: Received[] = []
const cpp = {
  answer: "notice" as "notice" | "none" | "never" | "fail",
  notice: "src/a.ts is also being changed in [t2] 'Config loader' (sam as build, active). Coordinate before you go on.",
}
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    received.push({
      path: url.pathname,
      body: (await request.json()) as Received["body"],
      session: request.headers.get("x-pacer-session"),
      agent: request.headers.get("x-pacer-agent"),
    })
    if (cpp.answer === "never") return new Promise<Response>(() => {})
    if (cpp.answer === "fail") return Response.json({ error: { message: "boom" } }, { status: 500 })
    return Response.json({ notice: cpp.answer === "notice" ? cpp.notice : null })
  },
})
afterAll(() => {
  server.stop(true)
  fs.rmSync(root, { recursive: true, force: true })
})

const catalogRef = Effect.runSync(SubscriptionRef.make<PacerModels.Catalog | undefined>(undefined))
const endpointRef = Effect.runSync(
  SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpointAt(`http://127.0.0.1:${server.port}`)),
)
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
const client = MemoryClient.layer.pipe(
  Layer.provide(PacerHttp.layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpoints))),
)
const projects = Layer.mock(PacerProject.Service, {
  chat: () => Effect.succeed({ project: PROJECT, headers: { "X-Pacer-Project": PROJECT } }),
  headers: (project) => ({ "X-Pacer-Project": project }),
})

/** The chats the plugin reads, by id. */
const sessions = new Map<string, Session.Info>()
const chat = (id: string, inside?: { task: string; subtask?: string }) => {
  const info = Session.Info.make({
    id: Session.ID.make(id),
    projectID: Project.ID.make(PROJECT),
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make(root) }),
    ...(inside ? { metadata: { memory: inside } } : {}),
  })
  sessions.set(id, info)
  return info.id
}

const tools = makeLocationNode({
  name: "test/task-files-tools",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      // As openforge registers them: their hooks are the registry's.
      const register = <R>(plugin: Parameters<typeof registerToolPlugin<R>>[0]) =>
        registerToolPlugin(
          plugin,
          {
            session: {
              get: (input) => Effect.succeed(sessions.get(input.sessionID)!),
              hook: (name, callback, options) => hooks.register("session", name, callback, options),
            },
          },
          (name, callback) => hooks.register("tool", name, callback),
        )
      yield* register(EditTool.Plugin)
      yield* register(WriteTool.Plugin)
      yield* register(PatchTool.Plugin)
      yield* register({
        id: TaskFilesPlugin.Plugin.id,
        effect: (ctx) =>
          TaskFilesPlugin.Plugin.effect(ctx).pipe(Effect.provide(Layer.mergeAll(catalogs, client, projects))),
      })
    }),
  ),
  deps: [
    Tool.node,
    PluginHooks.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})
const layer = AppNodeBuilder.build(LayerNode.group([Tool.node, PluginHooks.node, tools]), [
  Location.node.replace(
    Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(root) }))),
  ),
  Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
  Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
])
const it = testEffect(layer)

beforeEach(() => {
  received.length = 0
  cpp.answer = "notice"
  Effect.runSync(SubscriptionRef.set(catalogRef, catalogOf(true, { goals: true, later: true })))
})

/** A model request of the chat's, as its step makes one, through `provider`. */
const step = (sessionID: Session.ID, provider: string = PacerEndpoint.id, kind: "primary" | "title" = "primary") =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.trigger("session", "model.request", {
      sessionID,
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ id: Model.ID.make("claude"), providerID: Provider.ID.make(provider) }),
      kind,
      headers: {},
    })
  })

let calls = 0
/** Runs one call of a file tool in the chat, as the runner does. */
const run = (sessionID: Session.ID, name: string, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: `call-files-${++calls}`, name, input },
    })
  })

/** A file of the test's own in the chat's folder, its name relative to it. */
const file = (name: string, text?: string) => {
  const relative = `${crypto.randomUUID().slice(0, 8)}-${name}`
  if (text !== undefined) fs.writeFileSync(path.join(root, relative), text)
  return relative
}

const texts = (result: { readonly content?: ReadonlyArray<Tool.Content> }) =>
  (result.content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : []))

describe("the files report", () => {
  it.live("each file tool reports the paths it changed, in the chat's name, and the notice follows its result", () =>
    Effect.gen(function* () {
      const sessionID = chat("ses_files_tools", { task: "t4", subtask: "s1" })
      yield* step(sessionID)

      const edited = file("edit.ts", "before\n")
      const edit = yield* run(sessionID, EditTool.name, { path: edited, oldString: "before", newString: "after" })
      expect(edit.status).toBe("completed")
      expect(texts(edit)).toEqual([`Edited ${edited} (1 replacement)\n\n${cpp.notice}`])

      const written = file("write.ts")
      const write = yield* run(sessionID, WriteTool.name, { path: written, content: "x\n" })
      expect(texts(write)).toEqual([`Created file successfully: ${written}\n\n${cpp.notice}`])

      const updated = file("update.ts", "one\n")
      const removed = file("remove.ts", "gone\n")
      const added = file("add.ts")
      const patch = yield* run(sessionID, PatchTool.name, {
        patchText: `*** Begin Patch\n*** Add File: ${added}\n+new\n*** Update File: ${updated}\n@@\n-one\n+two\n*** Delete File: ${removed}\n*** End Patch`,
      })
      expect(patch.status).toBe("completed")
      expect(texts(patch).at(-1)?.endsWith(`\n\n${cpp.notice}`)).toBe(true)

      expect(received.map((item) => item.path)).toEqual(Array(3).fill(`/pacer/v1/memory/${PROJECT}/files`) as string[])
      expect(received.map((item) => item.body.paths)).toEqual([[edited], [written], [added, updated, removed]])
      expect(received.every((item) => typeof item.body.at === "number" && item.body.at > 0)).toBe(true)
      expect(received.every((item) => item.session === PacerSessionID.make(sessionID))).toBe(true)
      expect(received.every((item) => item.agent === "build")).toBe(true)
    }),
  )

  it.live("an answer without a notice adds nothing", () =>
    Effect.gen(function* () {
      cpp.answer = "none"
      const sessionID = chat("ses_files_quiet", { task: "t4" })
      yield* step(sessionID)
      const written = file("quiet.ts")
      const write = yield* run(sessionID, WriteTool.name, { path: written, content: "x\n" })
      expect(texts(write)).toEqual([`Created file successfully: ${written}`])
      expect(received).toHaveLength(1)
    }),
  )

  it.live("nothing is reported outside a task, without later, off CPP, or for a failed call", () =>
    Effect.gen(function* () {
      // In no task.
      const outside = chat("ses_files_outside")
      yield* step(outside)
      expect(texts(yield* run(outside, WriteTool.name, { path: file("a.ts"), content: "x\n" }))[0]).not.toContain(
        "Coordinate",
      )
      // A server without the later items.
      Effect.runSync(SubscriptionRef.set(catalogRef, catalogOf(true, { goals: true })))
      const inside = chat("ses_files_inside", { task: "t4" })
      yield* step(inside)
      yield* run(inside, WriteTool.name, { path: file("b.ts"), content: "x\n" })
      Effect.runSync(SubscriptionRef.set(catalogRef, catalogOf(true, { goals: true, later: true })))
      // A chat whose latest step went elsewhere; a title request of CPP's does not count as its step.
      yield* step(inside, "anthropic")
      yield* step(inside, PacerEndpoint.id, "title")
      yield* run(inside, WriteTool.name, { path: file("c.ts"), content: "x\n" })
      // A chat this process saw no step of.
      const unseen = chat("ses_files_unseen", { task: "t4" })
      yield* run(unseen, WriteTool.name, { path: file("d.ts"), content: "x\n" })
      // A failed call.
      yield* step(inside)
      const failed = yield* run(inside, EditTool.name, { path: file("missing.ts"), oldString: "a", newString: "b" })
      expect(failed.status).toBe("error")
      expect(received).toHaveLength(0)
      // Back on CPP, it reports again.
      yield* run(inside, WriteTool.name, { path: file("e.ts"), content: "x\n" })
      expect(received).toHaveLength(1)
    }),
  )

  it.live("a server that never answers holds the edit at most 500 ms, and adds nothing", () =>
    Effect.gen(function* () {
      cpp.answer = "never"
      const sessionID = chat("ses_files_slow", { task: "t4" })
      yield* step(sessionID)
      const written = file("slow.ts")
      const started = performance.now()
      const write = yield* run(sessionID, WriteTool.name, { path: written, content: "x\n" })
      const took = performance.now() - started
      expect(write.status).toBe("completed")
      expect(texts(write)).toEqual([`Created file successfully: ${written}`])
      expect(received).toHaveLength(1)
      expect(took).toBeGreaterThanOrEqual(450)
      expect(took).toBeLessThan(900)
      expect(fs.readFileSync(path.join(root, written), "utf8")).toBe("x\n")
    }),
  )

  it.live("a failing server adds nothing", () =>
    Effect.gen(function* () {
      cpp.answer = "fail"
      const sessionID = chat("ses_files_failing", { task: "t4" })
      yield* step(sessionID)
      const written = file("failing.ts")
      const write = yield* run(sessionID, WriteTool.name, { path: written, content: "x\n" })
      expect(texts(write)).toEqual([`Created file successfully: ${written}`])
      expect(received).toHaveLength(1)
    }),
  )
})

describe("paths", () => {
  it.effect("each tool's output names its paths: deduplicated, at most 50, none too long", () =>
    Effect.sync(() => {
      expect(TaskFilesPlugin.paths("edit", { files: [{ file: "a.ts" }], replacements: 1 })).toEqual(["a.ts"])
      expect(TaskFilesPlugin.paths("write", { resource: "b.ts" })).toEqual(["b.ts"])
      expect(
        TaskFilesPlugin.paths("patch", {
          applied: [
            { type: "add", resource: "c.ts" },
            { type: "update", resource: "c.ts" },
            { type: "delete", resource: "x".repeat(501) },
          ],
        }),
      ).toEqual(["c.ts"])
      expect(
        TaskFilesPlugin.paths("patch", {
          applied: Array.from({ length: 60 }, (_, index) => ({ type: "add", resource: `f${index}.ts` })),
        }),
      ).toHaveLength(50)
      expect(TaskFilesPlugin.paths("read", { resource: "b.ts" })).toEqual([])
      expect(TaskFilesPlugin.paths("write", undefined)).toEqual([])
    }),
  )
})
