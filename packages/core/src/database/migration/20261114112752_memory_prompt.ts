import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261114112752_memory_prompt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_prompt\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`project\` text NOT NULL,
          \`recall\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_memory_prompt_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_prompt_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

export default migration
