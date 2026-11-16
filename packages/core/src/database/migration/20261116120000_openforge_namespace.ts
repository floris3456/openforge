import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// The Code Mode namespace `opencode` became `openforge`; a stored schedule check calling its tools would otherwise fail
// every tick with "Unknown Code Mode tool".
const migration: DatabaseMigration.Migration = {
  id: "20261116120000_openforge_namespace",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `UPDATE \`schedule\` SET \`check\` = replace(\`check\`, 'tools.opencode.', 'tools.openforge.') WHERE \`check\` LIKE '%tools.opencode.%';`,
      )
    })
  },
}

export default migration
