import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261104154843_continuity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`pending_request\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`request\` text NOT NULL,
          \`agent\` text,
          \`reply\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_pending_request_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_rest\` (
          \`session_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`message_id\` text,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_rest_pk\` PRIMARY KEY(\`session_id\`, \`call_id\`),
          CONSTRAINT \`fk_session_rest_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`pending_request_session_idx\` ON \`pending_request\` (\`session_id\`);`)
    })
  },
}

export default migration
