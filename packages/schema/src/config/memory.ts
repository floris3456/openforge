export * as ConfigMemory from "./memory.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

/** A memory project's name, as the memory API takes it in its path. */
export const Project = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/u)).annotate({
  description: "1 to 128 characters of A-Z a-z 0-9 . _ -",
})

export class Info extends Schema.Class<Info>("Config.Memory")({
  project: Project.pipe(optional).annotate({
    description:
      "The memory project this directory's chats share, so that the repositories and worktrees of one workspace are one project; defaults to the project's own ID",
  }),
}) {}
