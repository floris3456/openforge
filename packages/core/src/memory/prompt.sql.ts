import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable, SessionTable } from "../session/sql.js"

/**
 * A person's prompt that memory was asked for and that got no message of close entries (`MemoryPrompt`): so it is not
 * asked again, and what followed reaches its row of the recall log. A prompt that got entries is recorded by its
 * message's metadata instead. It goes with the prompt, as a revert takes it back.
 */
export const MemoryPromptTable = sqliteTable("memory_prompt", {
  message_id: text()
    .$type<SessionMessage.ID>()
    .primaryKey()
    .references(() => SessionMessageTable.id, { onDelete: "cascade" }),
  session_id: text()
    .$type<SessionSchema.ID>()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  /** The memory project it was asked in. */
  project: text().notNull(),
  /** Its row of the recall log; null when there is none: a timeout, an error, memory closed, a server that logs nothing. */
  recall: text(),
  time_created: integer().notNull(),
})
