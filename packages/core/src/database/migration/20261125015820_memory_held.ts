import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261125015820_memory_held",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_held\` (
          \`helper_id\` text PRIMARY KEY,
          \`lead_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`input\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_memory_held_helper_id_session_v2_id_fk\` FOREIGN KEY (\`helper_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_held_lead_id_session_v2_id_fk\` FOREIGN KEY (\`lead_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_held_lead_idx\` ON \`memory_held\` (\`lead_id\`);`)
    })
  },
}

export default migration
