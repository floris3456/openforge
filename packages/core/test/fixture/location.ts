import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
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
