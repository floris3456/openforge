import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261116121524_prompt_start_parts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`prompt_system\` (
          \`hash\` text PRIMARY KEY,
          \`value\` text NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_prompt_start\` ADD \`parts\` text;`)
      yield* tx.run(`ALTER TABLE \`session_prompt_start\` ADD \`told_parts\` text;`)
    })
  },
}

export default migration
