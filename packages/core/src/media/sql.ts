import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"

/**
 * openforge (spec pictures-files): the chats whose pictures went once they were untouched for 30 days, with the
 * `time_updated` they had then, so a chat is gone through again only once it was touched since. From this table on, a
 * `blob` row's bytes may also be empty, kept as a file in the media folder beside the database.
 */
export const MediaClearedTable = sqliteTable("session_media_cleared", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  time_updated: integer().notNull(),
})
