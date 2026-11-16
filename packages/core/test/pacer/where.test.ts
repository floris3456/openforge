import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Git } from "@opencode/core/git"
import { Location } from "@opencode/core/location"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHeaders } from "@opencode/core/pacer/headers"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerWhere } from "@opencode/core/pacer/where"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionStore } from "@opencode/core/session/store"
import { Money } from "@opencode/schema/money"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Fiber, Layer, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { testEffect } from "../lib/effect"
import { endpointAt } from "../memory/fixture"

// Where a chat works (workspace reference `docs/reference/task-system-later-api.md`, "From the benchmark after the
// later items", "Where"): `X-Pacer-Where: <folder>@<branch>` on every request to CLIProxyPacer for a chat, the chat
// folder's git top folder (home as `~`) and its branch, a detached HEAD's short commit, the folder alone outside git;
// at most 300 characters cut from the left; asked of git once a folder and kept 30 s. Real git, in folders of the test's.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pacer-where-")))
const git = (cwd: string, ...args: string[]) => {
  const done = Bun.spawnSync(["git", "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd })
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`)
  return done.stdout.toString().trim()
}
const repository = path.join(root, "repos", "openforge")
fs.mkdirSync(path.join(repository, "packages"), { recursive: true })
fs.writeFileSync(path.join(repository, "packages", "x.ts"), "x\n")
git(repository, "init", "-q", "-b", "main")
git(repository, "add", ".")
git(repository, "commit", "-q", "-m", "first")
const worktree = path.join(root, "worktrees", "night", "openforge")
git(repository, "worktree", "add", "-q", "-b", "adj-of", worktree)
const detached = path.join(root, "worktrees", "detached", "openforge")
git(repository, "worktree", "add", "-q", "--detach", detached)
const commit = git(repository, "rev-parse", "HEAD")
const plain = path.join(root, "plain")
/** A folder as the header shows it: the test's home (script/test.ts keeps the temp folder in it) as `~`. */
const shown = (folder: string) =>
  folder.startsWith(Global.Path.home + "/") ? `~${folder.slice(Global.Path.home.length)}` : folder
fs.mkdirSync(plain)
afterAll(() => {
  server.stop(true)
  fs.rmSync(root, { recursive: true, force: true })
})

/** How the service's git behaves: as it is, failing, or never answering; and how often it was asked. */
const asked = { discover: 0, mode: "real" as "real" | "fail" | "never" }
beforeEach(() => {
  asked.discover = 0
  asked.mode = "real"
})

const received: Array<{ path: string; where: string | null }> = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    received.push({ path: new URL(request.url).pathname, where: request.headers.get("x-pacer-where") })
    return Response.json({ ok: true })
  },
})

const sessions = new Map<string, Session.Info>()
const chat = (id: string, directory: string) => {
  const info = Session.Info.make({
    id: Session.ID.make(id),
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
  })
  sessions.set(id, info)
  return info.id
}

const realGit = AppNodeBuilder.build(LayerNode.group([Git.node]))
const countedGit = Layer.effect(
  Git.Service,
  Effect.gen(function* () {
    const real = yield* Git.Service
    return Git.Service.of({
      ...real,
      repo: {
        ...real.repo,
        discover: (input) =>
          Effect.suspend(() => {
            asked.discover++
            if (asked.mode === "fail") return Effect.die(new Error("git is broken"))
            if (asked.mode === "never") return Effect.never
            return real.repo.discover(input)
          }),
      },
    })
  }),
).pipe(Layer.provide(realGit))
const store = Layer.mock(SessionStore.Service, {
  get: (sessionID) => Effect.succeed(sessions.get(sessionID)),
})
const where = PacerWhere.layer.pipe(Layer.provide(countedGit), Layer.provide(store))
const endpointRef = Effect.runSync(
  SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpointAt(`http://127.0.0.1:${server.port}`)),
)
const endpoint = Layer.succeed(
  PacerEndpoint.Service,
  PacerEndpoint.Service.of({
    get: () => SubscriptionRef.get(endpointRef),
    changes: () => SubscriptionRef.changes(endpointRef),
  }),
)
const http = PacerHttp.layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpoint))
const it = testEffect(Layer.provideMerge(http, where))

const Any = Schema.Unknown

describe("PacerWhere.format", () => {
  test("writes the home folder ~, adds the branch in git, and the folder alone outside it", () => {
    expect(
      PacerWhere.format({ folder: "/home/bliss/x/sub", top: "/home/bliss/x", branch: "main", home: "/home/bliss" }),
    ).toBe("~/x@main")
    expect(PacerWhere.format({ folder: "/home/bliss", top: "/home/bliss", branch: "dev", home: "/home/bliss/" })).toBe(
      "~@dev",
    )
    // Only a whole folder of home's: /home/blissful is not under /home/bliss.
    expect(PacerWhere.format({ folder: "/home/blissful/y", home: "/home/bliss" })).toBe("/home/blissful/y")
    expect(PacerWhere.format({ folder: "/srv/plain", home: "/home/bliss" })).toBe("/srv/plain")
    // In git with no branch to name (none found), the top folder alone.
    expect(PacerWhere.format({ folder: "/srv/r/a", top: "/srv/r", home: "/home/bliss" })).toBe("/srv/r")
  })

  test("keeps the last 300 characters of a longer value, its branch among them", () => {
    const top = "/srv/" + "a".repeat(400)
    const value = PacerWhere.format({ folder: top, top, branch: "feature", home: "/home/bliss" })
    expect(value).toHaveLength(300)
    expect(value).toBe(`${top}@feature`.slice(-300))
    const short = PacerWhere.format({ folder: "/srv/" + "b".repeat(295), home: "/home/bliss" })
    expect(short).toBe("/srv/" + "b".repeat(295))
  })

  test("percent-encodes a letter a header cannot hold", () => {
    expect(
      PacerWhere.format({
        folder: "/home/floris/Café",
        top: "/home/floris/Café",
        branch: "main",
        home: "/home/floris",
      }),
    ).toBe("~/Caf%C3%A9@main")
  })
})

const folder = (directory: string) => PacerWhere.Service.use((service) => service.folder(directory))

describe("PacerWhere", () => {
  it.effect("names a worktree's folder by its top folder and branch, from a folder inside it", () =>
    Effect.gen(function* () {
      // The test's home holds its folders, so they show from `~`.
      expect(shown(worktree)).toStartWith("~/")
      expect(yield* folder(path.join(worktree, "packages"))).toBe(`${shown(worktree)}@adj-of`)
      expect(yield* folder(repository)).toBe(`${shown(repository)}@main`)
    }),
  )

  it.effect("names a detached HEAD by its short commit", () =>
    Effect.gen(function* () {
      expect(yield* folder(detached)).toBe(`${shown(detached)}@${commit.slice(0, 7)}`)
    }),
  )

  it.effect("names a folder outside git alone, without @", () =>
    Effect.gen(function* () {
      expect(yield* folder(plain)).toBe(shown(plain))
    }),
  )

  it.effect("names the folder alone when git fails", () =>
    Effect.gen(function* () {
      asked.mode = "fail"
      expect(yield* folder(repository)).toBe(shown(repository))
    }),
  )

  it.effect("waits at most a second for git's first answer, then sends the folder alone", () =>
    Effect.gen(function* () {
      asked.mode = "never"
      const waiting = yield* folder(repository).pipe(Effect.forkChild)
      yield* TestClock.adjust("999 millis")
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 millis")
      expect(yield* Fiber.join(waiting)).toBe(shown(repository))
    }),
  )

  it.effect("cuts a long folder's value from the left", () =>
    Effect.gen(function* () {
      const deep = path.join(plain, ...Array.from({ length: 12 }, (_, index) => `${index}`.padStart(30, "d")))
      fs.mkdirSync(deep, { recursive: true })
      const value = yield* folder(deep)
      expect(shown(deep).length).toBeGreaterThan(300)
      expect(value).toBe(shown(deep).slice(-300))
    }),
  )

  it.effect("asks git once a folder, keeps it 30 s, then sends the old value while git is asked again", () =>
    Effect.gen(function* () {
      const kept = path.join(root, "worktrees", "kept", "openforge")
      git(repository, "worktree", "add", "-q", "-b", "kept", kept)
      expect(yield* Effect.all([folder(kept), folder(kept)], { concurrency: "unbounded" })).toEqual([
        `${shown(kept)}@kept`,
        `${shown(kept)}@kept`,
      ])
      expect(asked.discover).toBe(1)
      git(kept, "checkout", "-q", "-b", "moved")
      yield* TestClock.adjust("29 seconds")
      expect(yield* folder(kept)).toBe(`${shown(kept)}@kept`)
      expect(asked.discover).toBe(1)
      // Another folder is its own.
      expect(yield* folder(plain)).toBe(shown(plain))
      expect(asked.discover).toBe(2)

      yield* TestClock.adjust("1 second")
      // Past 30 s the old value goes at once, and git is asked on the side.
      expect(yield* folder(kept)).toBe(`${shown(kept)}@kept`)
      expect(asked.discover).toBe(3)
      let value = ""
      for (let tries = 0; tries < 200 && value !== `${shown(kept)}@moved`; tries++) {
        yield* Effect.promise(() => Bun.sleep(10))
        value = yield* folder(kept)
      }
      expect(value).toBe(`${shown(kept)}@moved`)
      expect(asked.discover).toBe(3)
    }),
  )
})

describe("PacerHttp with PacerWhere", () => {
  it.effect("adds where a chat works to each request that names the chat, and to none other", () =>
    Effect.gen(function* () {
      received.length = 0
      const pacer = yield* PacerHttp.Service
      const inWorktree = chat("ses_where_worktree", path.join(worktree, "packages"))
      const outside = chat("ses_where_plain", plain)
      yield* pacer.get("/pacer/v1/memory/p/chat", Any, { headers: PacerHeaders.chat({ sessionID: inWorktree }) })
      yield* pacer.post("/pacer/v1/memory/p/files", {}, Any, {
        headers: PacerHeaders.chat({ sessionID: outside, agent: "build" }),
      })
      yield* pacer.notify("/pacer/v1/chats/idle", {}, { headers: PacerHeaders.chat({ sessionID: inWorktree }) })
      // No chat named, or one this process never named: nothing to say.
      yield* pacer.get("/pacer/v1/capabilities", Any)
      yield* pacer.get("/pacer/v1/x", Any, { headers: { "X-Pacer-Session": "4f0b1d5c-0000-5000-8000-000000000000" } })
      // A chat gone from the store: nothing either.
      yield* pacer.get("/pacer/v1/y", Any, {
        headers: PacerHeaders.chat({ sessionID: Session.ID.make("ses_where_gone") }),
      })
      expect(received).toEqual([
        { path: "/pacer/v1/memory/p/chat", where: `${shown(worktree)}@adj-of` },
        { path: "/pacer/v1/memory/p/files", where: shown(plain) },
        { path: "/pacer/v1/chats/idle", where: `${shown(worktree)}@adj-of` },
        { path: "/pacer/v1/capabilities", where: null },
        { path: "/pacer/v1/x", where: null },
        { path: "/pacer/v1/y", where: null },
      ])
      expect(PacerSessionID.session(PacerSessionID.make(inWorktree))).toBe(inWorktree)
    }),
  )
})
