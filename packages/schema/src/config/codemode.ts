export * as ConfigCodeMode from "./codemode.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  pinned: Schema.Record(Schema.String, Schema.Boolean).pipe(optional).annotate({
    description:
      "Code Mode tools always listed in the catalog (true) or never pinned (false), by catalog path (`web_search`, `openforge.worktree_list`) or namespace (`context7.*`).",
  }),
})
