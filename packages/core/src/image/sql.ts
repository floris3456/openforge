import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"

/**
 * A chat's image bank (spec images): each optimized image's number in its chat, the name and sizes its line shows, and
 * the `blob` hash of its original, which a `blob_ref` of the chat keeps.
 */
export const ImageTable = sqliteTable(
  "session_image",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    hash: text().notNull(),
    name: text().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    shown_width: integer().notNull(),
    shown_height: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.number] })],
)
