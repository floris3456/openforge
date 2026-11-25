import fs from "fs"
import { Config } from "@opencode/core/config"
import { FileWrite } from "@opencode/core/file-write"
import { Flag } from "@opencode/core/flag"
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
import { FSUtil } from "@opencode/util/fs-util"
import { Git } from "@opencode/core/git"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "../lib/tool"
import { catalogOf, endpointAt } from "../memory/fixture"

// The files report (workspace reference `docs/reference/task-system-later-api.md`, "Edited files and the clash
// notice"): after each successful edit, write or patch of a chat whose latest step went through CLIProxyPacer, on a
// server with memory `later`, while the chat is inside a task, openforge posts the call's paths and appends CPP's notice
// to the tool's result; it waits at most 500 ms, and a timeout or failure adds nothing. A file in git is named by its
// repository (the folder holding its common git directory) and its path inside it, whichever worktree it is in; one
// outside git by its absolute path. The real file tools run in a folder of the file's own, through the real tool
// registry and its hooks, with real git; CPP is a small server of the test's own.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-files-")))
/**
 * A repository at `repos/openforge` with two more worktrees, as the workspace keeps them (one in a folder of another
 * name, so that only the repository names a file); the rest of `root` is no git.
 */
const git = (cwd: string, ...args: string[]) => {
  const done = Bun.spawnSync(["git", "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd })
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`)
}
const repository = path.join(root, "repos", "openforge")
fs.mkdirSync(path.join(repository, "packages"), { recursive: true })
fs.writeFileSync(path.join(repository, "packages", "x.ts"), "before\n")
git(repository, "init", "-q", "-b", "main")
git(repository, "add", ".")
git(repository, "commit", "-q", "-m", "first")
for (const name of ["a", "b"])
  git(
    repository,
    "worktree",
    "add",
    "-q",
    "-b",
    name,
    path.join(root, "worktrees", name, name === "a" ? "openforge" : "checkout"),
  )
/** How often the plugin asked git for a folder's repository. */
let discovered = 0
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
  chat: () => Effect.succeed({ project: PROJECT, headers: { "X-Pacer-Project": PROJECT }, repository: "/project" }),
  session: () => Effect.succeed({ project: PROJECT, headers: { "X-Pacer-Project": PROJECT }, repository: "/project" }),
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
      const real = yield* Git.Service
      const counted = Git.Service.of({
        ...real,
        repo: {
          ...real.repo,
          discover: (input) => Effect.sync(() => discovered++).pipe(Effect.andThen(real.repo.discover(input))),
        },
      })
      const files = yield* FSUtil.Service
      // As openforge registers them: their hooks are the registry's.
      const register = <R>(plugin: Parameters<typeof registerToolPlugin<R>>[0]) =>
        registerToolPlugin(
          plugin,
          {
            location: new Location.Info({
              directory: AbsolutePath.make(root),
              project: {
                id: Project.ID.global,
                directory: AbsolutePath.make(root),
                canonical: AbsolutePath.make(root),
              },
            }),
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
          TaskFilesPlugin.Plugin.effect(ctx).pipe(
            Effect.provide(Layer.mergeAll(catalogs, client, projects)),
            Effect.provideService(Git.Service, counted),
            Effect.provideService(FSUtil.Service, files),
          ),
      })
    }),
  ),
  deps: [
    Tool.node,
    PluginHooks.node,
    Git.node,
    FSUtil.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
    FileWrite.node,
    Config.node,
    Flag.node,
  ],
})
const layer = AppNodeBuilder.build(LayerNode.group([Tool.node, PluginHooks.node, Git.node, FSUtil.node, tools]), [
  Location.node.replace(
    Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(root) }))),
  ),
  Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
  Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
])
const it = testEffect(layer)

beforeEach(() => {
  received.length = 0
  discovered = 0
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

/** A file of the test's own in the chat's folder (or one below it), its name relative to the chat's folder. */
const file = (name: string, text?: string, folder = "") => {
  const relative = path.join(folder, `${crypto.randomUUID().slice(0, 8)}-${name}`)
  if (text !== undefined) fs.writeFileSync(path.join(root, relative), text)
  return relative
}
/** A file outside git as the report names it: its absolute path. */
const outside = (relative: string) => path.join(root, relative)

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
      expect(received.map((item) => item.body.paths)).toEqual([
        [outside(edited)],
        [outside(written)],
        [outside(added), outside(updated), outside(removed)],
      ])
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

describe("the names of files", () => {
  it.live("one file in two worktrees of a repository, and in its main checkout, is named alike", () =>
    Effect.gen(function* () {
      cpp.answer = "none"
      const sessionID = chat("ses_files_worktrees", { task: "t4" })
      yield* step(sessionID)
      const inA = path.join("worktrees", "a", "openforge", "packages", "x.ts")
      const inB = path.join("worktrees", "b", "checkout", "packages", "x.ts")
      expect((yield* run(sessionID, EditTool.name, { path: inA, oldString: "before", newString: "a" })).status).toBe(
        "completed",
      )
      yield* run(sessionID, WriteTool.name, { path: inB, content: "b\n" })
      yield* run(sessionID, PatchTool.name, {
        patchText: "*** Begin Patch\n*** Update File: repos/openforge/packages/x.ts\n@@\n-before\n+main\n*** End Patch",
      })
      // Absolute, as a lead in another folder writes it.
      yield* run(sessionID, WriteTool.name, { path: path.join(root, inB), content: "c\n" })
      expect(received.map((item) => item.body.paths)).toEqual(Array.from({ length: 4 }, () => ["openforge/packages/x.ts"]))
    }),
  )

  it.live("a file outside git is named by its absolute path", () =>
    Effect.gen(function* () {
      cpp.answer = "none"
      const sessionID = chat("ses_files_plain", { task: "t4" })
      yield* step(sessionID)
      fs.mkdirSync(path.join(root, "plain"), { recursive: true })
      const written = file("plain.ts", undefined, "plain")
      yield* run(sessionID, WriteTool.name, { path: written, content: "x\n" })
      expect(received.map((item) => item.body.paths)).toEqual([[path.join(root, "plain", path.basename(written))]])
    }),
  )

  it.live("git is asked once a folder: later edits in it cost no git call", () =>
    Effect.gen(function* () {
      cpp.answer = "none"
      const sessionID = chat("ses_files_cache", { task: "t4" })
      yield* step(sessionID)
      const folder = path.join("worktrees", "a", "openforge", "packages", "cached")
      fs.mkdirSync(path.join(root, folder), { recursive: true })
      const first = file("one.ts", undefined, folder)
      yield* run(sessionID, WriteTool.name, { path: first, content: "1\n" })
      expect(discovered).toBe(1)
      yield* run(sessionID, WriteTool.name, { path: file("two.ts", undefined, folder), content: "2\n" })
      yield* run(sessionID, EditTool.name, { path: first, oldString: "1", newString: "3" })
      expect(discovered).toBe(1)
      // Another folder is asked once too.
      fs.mkdirSync(path.join(root, folder, "deeper"), { recursive: true })
      yield* run(sessionID, WriteTool.name, {
        path: file("three.ts", undefined, path.join(folder, "deeper")),
        content: "4\n",
      })
      expect(discovered).toBe(2)
      expect(received.map((item) => item.body.paths[0]!.split("/").slice(0, 3).join("/"))).toEqual(
        Array(4).fill("openforge/packages/cached") as string[],
      )
    }),
  )
})

describe("paths", () => {
  it.effect(
    "each tool's result names its files, absolute, each once; a name is a repository's or the absolute path",
    () =>
      Effect.sync(() => {
        const files = (...names: string[]) => ({ metadata: { files: names.map((file) => ({ file })) } })
        expect(TaskFilesPlugin.paths("edit", files("a.ts"), "/w")).toEqual(["/w/a.ts"])
        expect(TaskFilesPlugin.paths("edit", files("/x/a.ts"), "/w")).toEqual(["/x/a.ts"])
        expect(TaskFilesPlugin.paths("write", { input: { path: "b.ts", content: "x" } }, "/w")).toEqual(["/w/b.ts"])
        expect(TaskFilesPlugin.paths("patch", files("c.ts", "c.ts", "../d.ts"), "/w")).toEqual(["/w/c.ts", "/d.ts"])
        expect(TaskFilesPlugin.paths("read", { input: { path: "b.ts" }, ...files("b.ts") }, "/w")).toEqual([])
        expect(TaskFilesPlugin.paths("write", {}, "/w")).toEqual([])
        expect(TaskFilesPlugin.repositoryName("/r/repos/openforge/.git")).toBe("openforge")
        const repository = { name: "openforge", worktree: "/r/worktrees/a/openforge" }
        expect(TaskFilesPlugin.named("/r/worktrees/a/openforge/src/x.ts", repository)).toBe("openforge/src/x.ts")
        expect(TaskFilesPlugin.named("/elsewhere/x.ts", repository)).toBe("/elsewhere/x.ts")
        expect(TaskFilesPlugin.named("/elsewhere/x.ts", undefined)).toBe("/elsewhere/x.ts")
      }),
  )

  it.live("a report holds at most 50 names, none longer than 500 characters", () =>
    Effect.gen(function* () {
      cpp.answer = "none"
      const sessionID = chat("ses_files_many", { task: "t4" })
      yield* step(sessionID)
      const many = Array.from(
        { length: 60 },
        (_, index) => `*** Add File: many-${index}-${crypto.randomUUID().slice(0, 6)}.ts\n+x`,
      )
      yield* run(sessionID, PatchTool.name, { patchText: `*** Begin Patch\n${many.join("\n")}\n*** End Patch` })
      expect(received[0]!.body.paths).toHaveLength(50)
    }),
  )
})
