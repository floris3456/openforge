// Runs one SQLite statement of a database copy (ReleaseDatabase.copy) on its own thread, given as `workerData`, and
// replies once.
import { Database } from "bun:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { errorMessage } from "../util/error"

export type Request = { readonly file: string; readonly sql: string; readonly params: ReadonlyArray<string> }
/** `error` says why the statement failed; without it, it ran. */
export type Reply = { readonly error?: string }

const port = parentPort
if (port) port.postMessage(run(workerData as Request))

function run(request: Request): Reply {
  try {
    using db = new Database(request.file)
    db.run(request.sql, [...request.params])
    return {}
  } catch (cause) {
    return { error: errorMessage(cause) }
  }
}
