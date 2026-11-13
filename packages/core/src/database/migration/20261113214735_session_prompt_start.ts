import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261113214735_session_prompt_start",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_prompt_start\` (
          \`session_id\` text PRIMARY KEY,
          \`agent\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`system\` text,
          \`tools\` text NOT NULL,
          \`told_system\` text,
          \`told_tools\` text NOT NULL,
          \`compaction\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_prompt_start_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`prompt_tools\` (
          \`hash\` text PRIMARY KEY,
          \`value\` text NOT NULL
        );
      `)
    })
  },
}

export default migration
