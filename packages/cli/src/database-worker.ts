// Third compile entrypoint: it lands next to index.js and the shared chunks in the executable, where ReleaseDatabase
// resolves "./database-worker.js".
import "./upgrade/database-worker"
