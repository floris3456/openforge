import { PacerProject } from "@opencode/core/pacer/project"
import { Effect, Layer } from "effect"

/** PacerProject's ancestors in a graph of one location, which holds no chat's lead: no helper finds a project there. */
export const noAncestors = Layer.succeed(
  PacerProject.Ancestors,
  PacerProject.Ancestors.of({ nearest: () => Effect.succeed(undefined) }),
)
