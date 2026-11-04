import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import { SessionTable } from "../session/sql.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"

/**
 * Where an execution rests, so the next process continues it: the Session's own record (`call_id` empty) and one row
 * per tool call that waits in a way that survives a stop.
 */
export const SessionRestTable = sqliteTable(
  "session_rest",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    call_id: text().notNull(),
    message_id: text().$type<SessionMessage.ID>(),
    data: text({ mode: "json" }).$type<unknown>(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.session_id, table.call_id] })],
)

/** Permission requests and questions a tool waits on, with the reply once one is given. */
export const PendingRequestTable = sqliteTable(
  "pending_request",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    kind: text().$type<"permission" | "form">().notNull(),
    message_id: text().notNull(),
    call_id: text().notNull(),
    request: text({ mode: "json" }).$type<unknown>().notNull(),
    agent: text(),
    reply: text({ mode: "json" }).$type<unknown>(),
    ...Timestamps,
  },
  (table) => [index("pending_request_session_idx").on(table.session_id)],
)
