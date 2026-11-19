import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// The Code Mode namespace `opencode` became `openforge`; a stored schedule check calling its tools would otherwise fail
// every tick with "Unknown Code Mode tool". A database made after upstream's automations
// (20261116043204_automation) no longer has the table: that migration dropped schedules with a check.
const migration: DatabaseMigration.Migration = {
  id: "20261116120000_openforge_namespace",
  up(tx) {
    return Effect.gen(function* () {
      const tables = yield* tx.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule'`,
      )
      if (tables.length === 0) return
      yield* tx.run(
        `UPDATE \`schedule\` SET \`check\` = replace(\`check\`, 'tools.opencode.', 'tools.openforge.') WHERE \`check\` LIKE '%tools.opencode.%';`,
      )
    })
  },
}

export default migration
