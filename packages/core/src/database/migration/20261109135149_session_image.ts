import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261109135149_session_image",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_image\` (
          \`session_id\` text NOT NULL,
          \`number\` integer NOT NULL,
          \`hash\` text NOT NULL,
          \`name\` text NOT NULL,
          \`width\` integer NOT NULL,
          \`height\` integer NOT NULL,
          \`shown_width\` integer NOT NULL,
          \`shown_height\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_image_pk\` PRIMARY KEY(\`session_id\`, \`number\`),
          CONSTRAINT \`fk_session_image_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

export default migration
