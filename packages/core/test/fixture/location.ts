import path from "path"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Effect, Layer } from "effect"
import { tmpdir } from "./tmpdir"

export function location(
  ref: Location.Ref,
  input: { projectDirectory?: AbsolutePath; vcs?: Project.Vcs; remote?: string } = {},
) {
  const directory = input.projectDirectory ?? ref.directory
  return {
    directory: ref.directory,
    workspaceID: ref.workspaceID,
    project: { id: Project.ID.global, directory, canonical: directory },
    vcs: input.vcs,
    ...(input.remote ? { remote: input.remote } : {}),
  } satisfies Location.Interface
}

/** A location at `directory` as a layer node's replacement, its project's remote when given. */
export const locationNode = (directory: string, remote?: string) =>
  Location.node.replace(
    Layer.succeed(
      Location.Service,
      Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(directory) }), { remote })),
    ),
  )

/** A checkout of a git repository at `directory`: only a git repository's chats name a project to CLIProxyPacer. */
export const gitVcs = (directory: string): Project.Vcs => ({
  type: "git",
  store: AbsolutePath.make(path.join(directory, ".git")),
})

/** {@link locationNode} as a git repository's checkout. */
export const gitLocationNode = (directory: string, remote?: string) =>
  Location.node.replace(
    Layer.succeed(
      Location.Service,
      Location.Service.of(
        location(Location.Ref.make({ directory: AbsolutePath.make(directory) }), { remote, vcs: gitVcs(directory) }),
      ),
    ),
  )

/** `Location.boundNode`'s location for `directory`, its project resolved as openforge resolves it, as a git checkout. */
export const gitBoundNode = (directory: string) =>
  Location.node.replace(
    makeLocationNode({
      service: Location.Service,
      layer: Layer.effect(
        Location.Service,
        Effect.gen(function* () {
          const projects = yield* Project.Service
          const resolved = yield* projects.resolve(AbsolutePath.make(directory), { persist: false })
          return Location.Service.of({
            directory: AbsolutePath.make(directory),
            workspaceID: undefined,
            project: { id: resolved.id, directory: resolved.directory, canonical: resolved.canonical },
            vcs: gitVcs(directory),
          })
        }),
      ),
      deps: [Project.node],
    }),
  )

export const tempLocationLayer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) => {
      const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      return Layer.succeed(Location.Service, Location.Service.of(location(ref)))
    }),
  ),
)
