import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "./schema.js"
import { SessionTable } from "./sql.js"

/**
 * A chat's cached start as recorded at its latest cold point (`SessionPromptStart`): what it was recorded for, the
 * system text, and its tool definitions by their `prompt_tools` hash; and the start its latest reminder told it of.
 */
export const PromptStartTable = sqliteTable("session_prompt_start", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  agent: text().notNull(),
  provider_id: text().notNull(),
  model_id: text().notNull(),
  /** The agent's prompt as sent; null when the request that recorded it carried none. */
  system: text(),
  tools: text().notNull(),
  /** The start the chat was last told of: as recorded, then as of its latest reminder. */
  told_system: text(),
  told_tools: text().notNull(),
  /** The `seq` of the chat's latest completed compaction when it was recorded; null before any. */
  compaction: integer(),
  time_created: integer().notNull(),
})

/** Tool definition lists by the SHA-256 of their JSON, each stored once however many chats use it. */
export const PromptToolsTable = sqliteTable("prompt_tools", {
  hash: text().primaryKey(),
  /** The definitions as JSON, as `ToolDefinition` encodes them. */
  value: text().notNull(),
})
