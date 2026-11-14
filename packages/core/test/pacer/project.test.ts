import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { PacerProject } from "@opencode/core/pacer/project"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Document, Info } from "@opencode/schema/config"
import { ConfigMemory } from "@opencode/schema/config/memory"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const id = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** PacerProject for a location whose checkout is `directory`, its main one `canonical`, over config `entries`. */
const projectAt = (
  where: { readonly directory: string; readonly canonical?: string; readonly remote?: string },
  entries: { current: Effect.Success<ReturnType<Config.Interface["entries"]>> } = { current: [] },
) =>
  PacerProject.Service.pipe(
    Effect.provide(
      PacerProject.layer.pipe(
        Layer.provide(
          Layer.succeed(
            Location.Service,
            Location.Service.of({
              directory: AbsolutePath.make(where.directory),
              project: {
                id: Project.ID.make(id),
                directory: AbsolutePath.make(where.directory),
                canonical: AbsolutePath.make(where.canonical ?? where.directory),
              },
              ...(where.remote ? { remote: where.remote } : {}),
            }),
          ),
        ),
        // One array until it is replaced, as Config's entries are until it reloads.
        Layer.provide(Layer.mock(Config.Service, { entries: () => Effect.sync(() => entries.current) })),
      ),
    ),
  )

const named = (project: string) => [
  new Document({ type: "document", info: new Info({ memory: new ConfigMemory.Info({ project }) }) }),
]

describe("PacerProject", () => {
  it.effect("names a repository with a remote by the normalised remote, and sends the remote", () =>
    Effect.gen(function* () {
      const projects = yield* projectAt({ directory: "/home/floris/openforge", remote: "github.com/owner/repo" })
      expect(yield* projects.chat(id)).toEqual({
        project: id,
        headers: {
          "X-Pacer-Project": id,
          "X-Pacer-Project-Name": "github.com%2Fowner%2Frepo",
          "X-Pacer-Project-Remote": "github.com%2Fowner%2Frepo",
        },
      })
    }),
  )

  it.effect("names a repository without a remote by its main checkout's folder, and sends no remote", () =>
    Effect.gen(function* () {
      const projects = yield* projectAt({
        directory: "/home/floris/worktrees/task/openforge-task",
        canonical: "/home/floris/openforge",
      })
      expect((yield* projects.chat(id)).headers).toEqual({
        "X-Pacer-Project": id,
        "X-Pacer-Project-Name": "openforge",
      })
    }),
  )

  it.effect("names a folder outside git by its name, a non-ASCII one percent-encoded", () =>
    Effect.gen(function* () {
      const projects = yield* projectAt({ directory: "/home/floris/Café 项目" })
      const headers = (yield* projects.chat(id)).headers
      expect(headers["X-Pacer-Project-Name"]).toBe("Caf%C3%A9%20%E9%A1%B9%E7%9B%AE")
      expect(decodeURIComponent(headers["X-Pacer-Project-Name"]!)).toBe("Café 项目")
      expect(headers).not.toHaveProperty("X-Pacer-Project-Remote")
    }),
  )

  it.effect("names no project for a chat outside any project", () =>
    Effect.gen(function* () {
      const projects = yield* projectAt({ directory: "/tmp/scratch", remote: "github.com/owner/repo" })
      expect(yield* projects.chat(Project.ID.global)).toEqual({ project: undefined, headers: {} })
    }),
  )

  it.effect("names memory.project when config sets it, and follows config once it reloads", () =>
    Effect.gen(function* () {
      const entries: { current: Effect.Success<ReturnType<Config.Interface["entries"]>> } = {
        current: named("openforge-workspace"),
      }
      const projects = yield* projectAt({ directory: "/home/floris/openforge" }, entries)
      expect(yield* projects.chat(id)).toEqual({
        project: "openforge-workspace",
        headers: { "X-Pacer-Project": "openforge-workspace", "X-Pacer-Project-Name": "openforge" },
      })
      // A chat outside any project shares the one config names, as its memory does.
      expect((yield* projects.chat(Project.ID.global)).project).toBe("openforge-workspace")
      entries.current = []
      expect((yield* projects.chat(id)).project).toBe(id)
    }),
  )

  it.effect("works a project's headers out once, and the same for a memory project named directly", () =>
    Effect.gen(function* () {
      const projects = yield* projectAt({ directory: "/home/floris/openforge", remote: "github.com/owner/repo" })
      const first = yield* projects.chat(id)
      expect(yield* projects.chat(id)).toBe(first)
      expect(projects.headers(id)).toBe(first.headers)
      expect(projects.headers("bad project")).toEqual({})
    }),
  )
})
