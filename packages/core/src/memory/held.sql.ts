import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"

/**
 * A lead's message to its helper held until the lead answers the helper's handed-in round (`MemoryHeld`): one per
 * helper, a newer message replacing it. It enters the helper's inbox only when released, with `message_id`, so a release
 * tried again after a stop admits it once. It goes with either chat.
 */
export const MemoryHeldTable = sqliteTable(
  "memory_held",
  {
    helper_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    lead_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().$type<SessionMessage.ID>().notNull(),
    /** The subagent call as the lead wrote it: `{agent, description, prompt, model?, taskID?}`. */
    input: text({ mode: "json" }).notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("memory_held_lead_idx").on(table.lead_id)],
)
