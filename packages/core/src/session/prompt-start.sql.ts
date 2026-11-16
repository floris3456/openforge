import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "./schema.js"
import { SessionTable } from "./sql.js"

/**
 * A chat's cached start as recorded at its latest cold point (`SessionPromptStart`): what it was recorded for, its
 * system parts by their `prompt_system` hash and its tool definitions by their `prompt_tools` hash, both as sent; and
 * the start its latest reminder told it of.
 */
export const PromptStartTable = sqliteTable("session_prompt_start", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  agent: text().notNull(),
  provider_id: text().notNull(),
  model_id: text().notNull(),
  /**
   * Before the system parts were recorded: the agent's prompt alone, with `tools` the definitions before the hooks.
   * No longer written; kept so that a release before it still reads the table.
   */
  system: text(),
  tools: text().notNull(),
  /** Before `told_parts`: the agent's prompt the chat was last told of. No longer written. */
  told_system: text(),
  told_tools: text().notNull(),
  /** The system parts as sent, by their `prompt_system` hash; null in a record made before they were recorded. */
  parts: text(),
  /** The system parts the chat was last told of: as recorded, then as of its latest reminder. */
  told_parts: text(),
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

/** System part lists by the SHA-256 of their JSON, each stored once however many chats use it. */
export const PromptSystemTable = sqliteTable("prompt_system", {
  hash: text().primaryKey(),
  /** The parts as JSON, as `SystemPart` encodes them. */
  value: text().notNull(),
})
