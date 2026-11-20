import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// openforge (spec pictures-files): from here on a `blob` row's bytes may be empty, kept as a file named by their hash in
// the media folder beside the database. Nothing to change in the schema; this entry is what keeps a release from before
// it, which would read those rows as empty pictures, from opening this database without the copy made when it was left.
const migration: DatabaseMigration.Migration = {
  id: "20261120120000_media_files",
  up() {
    return Effect.void
  },
}

export default migration
