import { Database } from "bun:sqlite"
import { nearest, search, tokenizer, waiting, type Scopes } from "./memory-search"

/**
 * The small memory server: the memory API (the workspace's `docs/reference/memory-api.md`) on `Bun.serve` and
 * `bun:sqlite`, for openforge's tests and as the contract in code. Matching, merging and the cut live in
 * `memory-search.ts`. With an embedding endpoint (OpenAI-style `POST <url>/embeddings`) every entry gets a vector of
 * its text and basis, and a search ranks by meaning too.
 *
 * Every write is one SQLite transaction (`BEGIN IMMEDIATE`), and Bun's SQLite is synchronous, so the exact-copy rule
 * and a replacement hold for writers that arrive at once, in this process or another one on the same file.
 *
 * Every project has memory, for every key, until `project()` switches it off or names the keys that may use it; its
 * routes then answer as CLIProxyPacer's projects do (the workspace's spec `docs/specs/cpp-projects.md`, "Memory routes"):
 * `404 project_memory_off`, or `403 project_forbidden`, before anything else is checked, the answer naming the project
 * and whether the chat was moved into it. A chat `chat()` made known (as a model request does on CLIProxyPacer) can be
 * moved into another project with `move()`: its memory calls, found by `X-Pacer-Session` and the key, and those of its
 * subagents not moved themselves, then use that project ("Memory follows the project").
 *
 * As a script: `bun memory-server.ts --port <n> --key <key>[=<label>] [--key …] [--file <path>]
 * [--embedding-url <url> --embedding-model <name> [--embedding-key <key>]]`.
 */

export const capabilities = {
  version: 1,
  entry_characters: 800,
  query_characters: 2000,
  search_limit: 20,
  tasks: true,
  recalls: true,
  projects: true,
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
const BODY_BYTES = 64 * 1024
const KINDS = ["words", "unverified", "verified"]
/** How long the endpoint may take: for an entry's vector, and for a query's. */
const ENTRY_MS = 2000
const QUERY_MS = 1000
/** How many waiting entries one background call embeds. */
const BATCH = 16
/** How many of the nearest entries a write answers. */
const NEAR = 3
const SCOPES = ["global", "role", "task"]
const STATES = ["todo", "active", "blocked", "review", "done"]
/** How many tasks a list answers, and how many changes and entries a read. */
const LIST = 200
const READ = 20
/** The recall log: how long a row is kept, how long what followed may be, how many judges label a row. */
const KEPT_MS = 30 * 24 * 60 * 60 * 1000
const STEP = 4000
const PERSON = 2000
const JUDGES = 10
const LABELS = ["used", "beside", "unsure"]
const ACTS = ["superseded", "forgotten"]

/** Characters a reader cannot see and those that end a line: the contract's table, as inclusive ranges. */
const REFUSED = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x2028, 0x2029],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
  [0xfff9, 0xfffb],
  [0xe000, 0xf8ff],
  [0xf0000, 0x10ffff],
]

const SCHEMA = [
  `create table if not exists entry (
    seq integer primary key autoincrement,
    id text not null unique,
    project text not null,
    kind text not null,
    text text,
    basis text,
    scope text not null,
    role text,
    task text,
    subtask text,
    by text not null,
    at integer not null,
    supersedes text,
    superseded_by text,
    deleted text,
    vector blob,
    vector_model text
  )`,
  `create index if not exists entry_project on entry (project, scope, role, task)`,
  `create virtual table if not exists entry_fts using fts5(text, basis, tokenize="${tokenizer}")`,
  `create table if not exists recall (
    seq integer primary key autoincrement,
    id text not null unique,
    project text not null,
    kind text not null,
    query text not null,
    scopes text not null,
    kinds text not null,
    entries text not null,
    meaning integer not null,
    by text not null,
    at integer not null,
    after text,
    labels text not null
  )`,
  `create table if not exists task (
    seq integer primary key autoincrement,
    id text not null unique,
    project text not null,
    parent text,
    title text not null,
    description text not null,
    state text not null,
    note text,
    by text not null,
    worker text,
    at integer not null,
    changed integer not null
  )`,
  `create table if not exists task_change (
    seq integer primary key autoincrement,
    project text not null,
    task text not null,
    state text not null,
    note text,
    by text not null,
    at integer not null
  )`,
]

/** A stored entry: `by` and `deleted` are JSON, `vector` a Float32Array of length 1 as bytes. */
type Row = {
  seq: number
  id: string
  project: string
  kind: string
  text: string | null
  basis: string | null
  scope: string
  role: string | null
  task: string | null
  subtask: string | null
  by: string
  at: number
  supersedes: string | null
  superseded_by: string | null
  deleted: string | null
  vector: Uint8Array | null
  vector_model: string | null
}

/** A stored task: `by` and `worker` are JSON. */
type TaskRow = {
  seq: number
  id: string
  project: string
  parent: string | null
  title: string
  description: string
  state: string
  note: string | null
  by: string
  worker: string | null
  at: number
  changed: number
}

/** A row of the recall log: `scopes`, `kinds`, `entries`, `by`, `after` and `labels` are JSON. */
type RecallRow = {
  seq: number
  id: string
  project: string
  kind: string
  query: string
  scopes: string
  kinds: string
  entries: string
  meaning: number
  by: string
  at: number
  after: string | null
  labels: string
}

type After = {
  step: string | null
  acted: { id: string; how: string }[] | null
  person: string | null
  step_at: number | null
  person_at: number | null
}

type Labels = { judge: string; entries: { id: string; label: string }[]; corrected: string | null; at: number }

type ChangeRow = {
  seq: number
  project: string
  task: string
  state: string
  note: string | null
  by: string
  at: number
}

/** An OpenAI-style embedding endpoint: `url` is its base, such as `http://127.0.0.1:18433/v1`. */
type Embedding = { readonly url: string; readonly model: string; readonly key?: string }

type Fields = Record<string, unknown>

/** Starts the server on 127.0.0.1. A key without a label is the person `key-` and its last four characters. */
export function startMemoryServer(input: {
  readonly keys: ReadonlyArray<{ readonly key: string; readonly label?: string }>
  readonly port?: number
  readonly file?: string
  readonly embedding?: Embedding
}) {
  const people = new Map(input.keys.map((item) => [item.key, item.label ?? `key-${item.key.slice(-4)}`]))
  const db = new Database(input.file ?? ":memory:", { create: true })
  db.run("pragma journal_mode = wal")
  db.run("pragma busy_timeout = 5000")
  SCHEMA.forEach((statement) => db.run(statement))
  const store = storeOf(db, input.embedding)
  /** The projects switched by `project()`; `keys` null for every key. */
  const projects = new Map<
    string,
    { readonly memory: boolean; readonly keys: ReadonlySet<string> | null; readonly name?: string }
  >()
  /** The chats `chat()` made known, by key and chat: the parent each names, and the project it was moved into. */
  const chats = new Map<string, { readonly parent?: string; readonly moved: string | null }>()
  const chatOf = (key: string, chat: string) => `${key} ${chat}`
  /** The chat's own move, else the nearest up its chat tree, which is followed 16 steps at most. */
  const moveOf = (key: string, chat: string | undefined, steps = 16): string | undefined => {
    if (chat === undefined || steps === 0) return undefined
    const known = chats.get(chatOf(key, chat))
    return known?.moved ?? moveOf(key, known?.parent, steps - 1)
  }

  const guarded =
    <R extends Request>(handle: (request: R, person: string, project: string) => Response | Promise<Response>) =>
    (request: R) => {
      const key = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1]
      if (!key) return Response.json({ error: "Missing API key" }, { status: 401 })
      const person = people.get(key)
      if (!person) return Response.json({ error: "Invalid API key" }, { status: 401 })
      const identity = (request as Request & { params?: Record<string, string> }).params?.project
      if (identity === undefined) return handle(request, person, "")
      const moved = moveOf(key, request.headers.get("x-pacer-session") ?? undefined)
      const project = moved ?? identity
      const setting = projects.get(project)
      const named = { project: { id: project, name: setting?.name ?? project }, moved: moved !== undefined }
      const where = moved === undefined ? "this project" : "the project this chat was moved to"
      if (setting && !setting.memory)
        return failure(
          404,
          "project_memory_off",
          `memory is off for ${where}: turn memory on for this project on CLIProxyPacer's Projects page`,
          named,
        )
      if (setting?.keys && !setting.keys.has(key))
        return failure(
          403,
          "project_forbidden",
          `this key may not use the memory of ${where}: allow it for this project on CLIProxyPacer's Projects page`,
          named,
        )
      return handle(request, person, project)
    }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 0,
    routes: {
      "/pacer/v1/capabilities": {
        GET: guarded(() =>
          Response.json({
            pacer: { memory: { ...capabilities, embedding: input.embedding?.model ?? null } },
            providers: [],
            models: [],
          }),
        ),
      },
      "/pacer/v1/memory/:project/entries": {
        POST: guarded(async (request, person, project) =>
          store.write(projectOf(project), await bodyOf(request), person),
        ),
      },
      "/pacer/v1/memory/:project/entries/:id": {
        GET: guarded((request, _person, project) => store.read(projectOf(project), request.params.id)),
      },
      "/pacer/v1/memory/:project/entries/:id/forget": {
        POST: guarded(async (request, person, project) =>
          store.forget(projectOf(project), request.params.id, await bodyOf(request), person),
        ),
      },
      "/pacer/v1/memory/:project/search": {
        POST: guarded(async (request, person, project) =>
          store.search(projectOf(project), await bodyOf(request), person),
        ),
      },
      "/pacer/v1/memory/:project/start": {
        POST: guarded(async (request, person, project) =>
          store.start(projectOf(project), await bodyOf(request), person),
        ),
      },
      "/pacer/v1/memory/:project/tasks": {
        POST: guarded(async (request, person, project) =>
          store.make(projectOf(project), await bodyOf(request), person),
        ),
        GET: guarded((request, _person, project) =>
          store.tasks(projectOf(project), new URL(request.url).searchParams.get("all") === "1"),
        ),
      },
      "/pacer/v1/memory/:project/tasks/:id": {
        GET: guarded((request, _person, project) => store.task(projectOf(project), request.params.id)),
      },
      "/pacer/v1/memory/:project/tasks/:id/state": {
        POST: guarded(async (request, person, project) =>
          store.change(projectOf(project), request.params.id, await bodyOf(request), person),
        ),
      },
      "/pacer/v1/memory/:project/recalls": {
        GET: guarded((request, _person, project) =>
          store.recalls(projectOf(project), new URL(request.url).searchParams),
        ),
      },
      "/pacer/v1/memory/:project/recalls/:id": {
        GET: guarded((request, _person, project) => store.recall(projectOf(project), request.params.id)),
      },
      "/pacer/v1/memory/:project/recalls/:id/after": {
        POST: guarded(async (request, _person, project) =>
          store.after(projectOf(project), request.params.id, await bodyOf(request)),
        ),
      },
      "/pacer/v1/memory/:project/recalls/:id/labels": {
        POST: guarded(async (request, _person, project) =>
          store.label(projectOf(project), request.params.id, await bodyOf(request)),
        ),
      },
      "/pacer/v1/memory/:project/export": {
        GET: guarded((request, _person, project) => store.export(projectOf(project))),
      },
    },
    fetch: (request) =>
      new URL(request.url).pathname.startsWith("/pacer/v1/")
        ? guarded(() => failure(404, "not_found", "no such route"))(request)
        : failure(404, "not_found", "no such route"),
    error: (error) =>
      error instanceof Refusal
        ? failure(error.status, error.type, error.message)
        : failure(500, "internal", `${error}`),
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    /**
     * Switches a project's memory, names the keys that may use it (all when left out or null), and its name as its
     * closed answers give it (the identity when left out).
     */
    project: (
      identity: string,
      setting: {
        readonly memory: boolean
        readonly keys?: ReadonlyArray<string> | null
        readonly name?: string
      },
    ) =>
      void projects.set(identity, {
        memory: setting.memory,
        keys: setting.keys ? new Set(setting.keys) : null,
        ...(setting.name === undefined ? {} : { name: setting.name }),
      }),
    /** Makes a chat of `key` known, a subagent of `parent` when it names one. */
    chat: (key: string, chat: string, parent?: string) =>
      void chats.set(chatOf(key, chat), {
        ...(parent === undefined ? {} : { parent }),
        moved: chats.get(chatOf(key, chat))?.moved ?? null,
      }),
    /** The owner's move of a known chat into the project `identity` names, or back with null. */
    move: (key: string, chat: string, identity: string | null) => {
      const known = chats.get(chatOf(key, chat))
      if (!known) throw new Error(`no chat ${chat} of this key is known`)
      chats.set(chatOf(key, chat), { ...known, moved: identity })
    },
    stop: async () => {
      store.stop()
      await server.stop(true)
      db.close()
    },
  }
}

function storeOf(db: Database, embedding: Embedding | undefined) {
  const get = (project: string, id: string) =>
    db.query<Row, string[]>("select * from entry where project = ? and id = ?").get(project, id)
  const live = "superseded_by is null and deleted is null"
  const getTask = (project: string, id: string) =>
    db.query<TaskRow, string[]>("select * from task where project = ? and id = ?").get(project, id)
  /** What `GET …/tasks/{id}` answers for a task, and `start` for the chat's task and subtask. */
  const readOf = (row: TaskRow) => ({
    task: taskOf(row),
    changes: db
      .query<
        ChangeRow,
        [string, string]
      >(`select * from task_change where project = ? and task = ? order by seq desc limit ${READ}`)
      .all(row.project, row.id)
      .map(changeOf),
    subtasks: subtasksOf(row),
    entries: taskEntries(row),
  })
  const subtasksOf = (row: TaskRow) =>
    row.parent !== null
      ? []
      : db
          .query<TaskRow, string[]>("select * from task where project = ? and parent = ? order by seq")
          .all(row.project, row.id)
          .map(taskOf)
  /** The live task entries of a task, those written in its subtasks too; of a subtask only its own. */
  const taskEntries = (row: TaskRow) =>
    db
      .query<Row, string[]>(
        `select * from entry where project = ? and scope = 'task' and ${live} and ${row.parent === null ? "task = ?" : "subtask = ?"}
         order by seq desc limit ${READ}`,
      )
      .all(row.project, row.id)
      .map(entryOf)
  // `catching` keeps one background catch-up at a time; `stopped` keeps a late answer off a closed database.
  let catching = false
  let stopped = false

  return {
    async write(project: string, body: Fields, person: string) {
      const kind = oneOf(body.kind, KINDS, "kind")
      const text = visible(body.text, "text").trim()
      if (!text) refuse("text: must not be empty")
      const basis = body.basis === undefined || body.basis === null ? "" : visible(body.basis, "basis").trim()
      if (kind === "words" && basis) refuse("basis: an entry of kind words has no basis")
      if (kind !== "words" && !basis) refuse(`basis: an entry of kind ${kind} needs a basis`)
      if ([...text].length + [...basis].length > capabilities.entry_characters)
        refuse(
          `text: text and basis together have ${[...text].length + [...basis].length} characters, more than ${capabilities.entry_characters}`,
        )
      const by = { person, ...byOf(body.by) }
      const supersedes = body.supersedes === undefined || body.supersedes === null ? null : body.supersedes
      if (supersedes !== null && typeof supersedes !== "string") refuse("supersedes: must be an entry id or null")
      if (body.move !== undefined && body.move !== null && typeof body.move !== "boolean")
        refuse("move: must be true, false or null")
      // A new entry, or a replacement that moves, belongs where the body's scope says.
      const home = supersedes === null || body.move === true ? homeOf(body.scope, by) : undefined

      const written = db
        .transaction(() => {
          const replaced =
            supersedes === null
              ? undefined
              : (get(project, supersedes) ??
                refuse(`supersedes: no entry ${supersedes} in this project`, 404, "not_found"))
          // Without move a replacement takes what the replaced entry belongs to; the body's scope is ignored.
          const target = home ?? {
            scope: replaced!.scope,
            role: replaced!.role,
            task: replaced!.task,
            subtask: replaced!.subtask,
          }
          // An exact copy is looked for before the replaced entry's state, so a retried replacement answers the entry it
          // made. The replaced entry is never its own copy: the same text with another kind or basis replaces it.
          const copy = db
            .query<
              Row,
              (string | null)[]
            >(`select * from entry where project = ? and scope = ? and role is ? and task is ? and text = ? and ${live} and id is not ?`)
            .get(project, target.scope, target.role, target.task, text, replaced?.id ?? null)
          if (copy) {
            // The text that was to take the replaced entry's place is there already: the copy replaces it.
            if (replaced && replaced.superseded_by === null && replaced.deleted === null) {
              db.run("update entry set superseded_by = ? where seq = ?", [copy.id, replaced.seq])
              db.run("delete from entry_fts where rowid = ?", [replaced.seq])
            }
            return { row: copy, existing: true }
          }
          if (replaced?.superseded_by)
            refuse(`supersedes: entry ${replaced.id} is already replaced by ${replaced.superseded_by}`, 409, "conflict")
          if (replaced?.deleted) refuse(`supersedes: entry ${replaced.id} is deleted`, 409, "conflict")
          const row = db
            .query<Row, (string | number | null)[]>(
              `insert into entry (id, project, kind, text, basis, scope, role, task, subtask, by, at, supersedes)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning *`,
            )
            .get(
              newID(),
              project,
              kind,
              text,
              basis,
              target.scope,
              target.role,
              target.task,
              target.subtask,
              JSON.stringify(by),
              Date.now(),
              supersedes,
            )!
          db.run("insert into entry_fts (rowid, text, basis) values (?, ?, ?)", [row.seq, text, basis])
          if (replaced) {
            db.run("update entry set superseded_by = ? where seq = ?", [row.id, replaced.seq])
            db.run("delete from entry_fts where rowid = ?", [replaced.seq])
          }
          return { row, existing: false }
        })
        .immediate()
      // An exact copy makes no call; a new entry waits for its vector, and is stored without one when the call fails.
      const vector = written.existing ? undefined : (await embed([source(written.row)], ENTRY_MS))?.[0]
      if (vector) stored(written.row.seq, vector)
      const near =
        vector && embedding && !stopped
          ? nearest<Row>(db, { project, id: written.row.id, vector, model: embedding.model, limit: NEAR }).map(
              (row) => ({ ...entryOf(row), score: row.score }),
            )
          : []
      catchUp()
      if (written.existing) return Response.json({ entry: entryOf(written.row), existing: true, near: [] })
      return Response.json({ entry: entryOf(written.row), near }, { status: 201 })
    },

    read(project: string, id: string) {
      const row = get(project, id)
      if (!row) refuse(`no entry ${id} in this project`, 404, "not_found")
      return Response.json({ entry: entryOf(row) })
    },

    forget(project: string, id: string, body: Fields, person: string) {
      const reason = visible(body.reason, "reason").trim()
      if (!reason || [...reason].length > 200) refuse("reason: must be 1 to 200 characters")
      const by = byOf(body.by)
      return db
        .transaction(() => {
          const row = get(project, id)
          if (!row) refuse(`no entry ${id} in this project`, 404, "not_found")
          if (row.deleted) return Response.json({ entry: entryOf(row) })
          const deleted = { at: Date.now(), by: { person, role: by.role, chat: by.chat }, reason }
          db.run(
            "update entry set text = null, basis = null, vector = null, vector_model = null, deleted = ? where seq = ?",
            [JSON.stringify(deleted), row.seq],
          )
          db.run("delete from entry_fts where rowid = ?", [row.seq])
          return Response.json({
            entry: entryOf({ ...row, text: null, basis: null, deleted: JSON.stringify(deleted) }),
          })
        })
        .immediate()
    },

    async search(project: string, body: Fields, person: string) {
      const query = queryOf(body.query, "query")
      const scopes = scopesOf(body.scopes)
      const kinds = kindsOf(body.kinds)
      const limit = limitOf(body.limit)
      const by = { person, ...byOf(body.by) }
      const answer = await found({ project, query, scopes, kinds, limit })
      const recall = logged(project, "search", query, body, answer, by)
      catchUp()
      return Response.json({ recall, ...answer })
    },

    async start(project: string, body: Fields, person: string) {
      const prompt = queryOf(body.prompt, "prompt")
      const scopes = scopesOf(body.scopes)
      const kinds = kindsOf(body.kinds)
      const limit = limitOf(body.limit)
      if (body.task !== undefined && body.task !== null && typeof body.task !== "string")
        refuse("task: must be a task id or null")
      if (body.subtask !== undefined && body.subtask !== null && typeof body.subtask !== "string")
        refuse("subtask: must be a task id or null")
      const by = { person, ...byOf(body.by) }
      const answer = await found({ project, query: prompt, scopes, kinds, limit })
      // A role entry has no task and a task entry no role, so `coalesce(role, task)` is what each belongs to.
      const count = (scope: string, list: string[] | "all") =>
        db
          .query<{ n: number }, (string | number)[]>(
            `select count(*) as n from entry where project = ? and scope = ? and ${live}
             and (? or coalesce(role, task) in (select value from json_each(?)))`,
          )
          .get(project, scope, list === "all" ? 1 : 0, JSON.stringify(list === "all" ? [] : list))?.n ?? 0
      const recall = logged(project, "start", prompt, body, answer, by)
      catchUp()
      // Only a task that has no parent is a chat's task; its subtask only when it is one of that task's.
      const task = typeof body.task === "string" ? getTask(project, body.task) : null
      const own = task && task.parent === null ? task : null
      const subtask = own && typeof body.subtask === "string" ? getTask(project, body.subtask) : null
      return Response.json({
        recall,
        ...answer,
        task: own ? readOf(own) : null,
        subtask: subtask && subtask.parent === own!.id ? readOf(subtask) : null,
        counts: {
          global: count("global", "all"),
          role: count("role", scopes === "all" ? "all" : scopes.roles),
          task: count("task", scopes === "all" ? "all" : scopes.tasks),
        },
      })
    },

    export(project: string) {
      const tasks = db
        .query<TaskRow, string[]>("select * from task where project = ? order by seq")
        .all(project)
        .map((row) => ({ type: "task", ...taskOf(row) }))
      const changes = db
        .query<ChangeRow, string[]>("select * from task_change where project = ? order by seq")
        .all(project)
        .map((row) => ({ type: "task_change", task: row.task, ...changeOf(row) }))
      const entries = db
        .query<Row, string[]>("select * from entry where project = ? order by seq")
        .all(project)
        .map((row) => ({ type: "entry", ...entryOf(row) }))
      const lines = [...tasks, ...changes, ...entries].map((line) => JSON.stringify(line) + "\n")
      return new Response(lines.join(""), { headers: { "content-type": "application/x-ndjson" } })
    },

    make(project: string, body: Fields, person: string) {
      const title = visible(body.title, "title").trim()
      if (!title || [...title].length > 200) refuse("title: must be 1 to 200 characters")
      const description =
        body.description === undefined || body.description === null
          ? ""
          : visible(body.description, "description", true).trim()
      if ([...description].length > 2000) refuse("description: must be at most 2000 characters")
      if (body.parent !== undefined && body.parent !== null && typeof body.parent !== "string")
        refuse("parent: must be a task id or null")
      const parentID = typeof body.parent === "string" ? body.parent : null
      const by = byOf(body.by)
      return db
        .transaction(() => {
          const parent = parentID === null ? null : getTask(project, parentID)
          if (parentID !== null && !parent) refuse(`parent: no task ${parentID} in this project`, 404, "not_found")
          if (parent?.parent) refuse(`parent: task ${parent.id} is a subtask, and a subtask has no subtasks`)
          // A task that is not done with the same title and parent is the one a call sent twice made.
          const copy = db
            .query<
              TaskRow,
              (string | null)[]
            >("select * from task where project = ? and title = ? and parent is ? and state != 'done' order by seq limit 1")
            .get(project, title, parentID)
          if (copy) return Response.json({ task: taskOf(copy), existing: true })
          const now = Date.now()
          const row = db
            .query<TaskRow, (string | number | null)[]>(
              `insert into task (id, project, parent, title, description, state, note, by, worker, at, changed)
               values (?, ?, ?, ?, ?, 'todo', null, ?, null, ?, ?) returning *`,
            )
            .get(
              newID(),
              project,
              parentID,
              title,
              description,
              JSON.stringify({ person, role: by.role, chat: by.chat }),
              now,
              now,
            )!
          return Response.json({ task: taskOf(row) }, { status: 201 })
        })
        .immediate()
    },

    tasks(project: string, all: boolean) {
      // Not done, and the done subtasks of a task that is not; with all, every task.
      const rows = db
        .query<TaskRow, [string, number]>(
          `select * from task where project = ? and (? or state != 'done' or (parent is not null and
           (select state from task as owner where owner.project = task.project and owner.id = task.parent) != 'done'))
           order by seq desc limit ${LIST + 1}`,
        )
        .all(project, all ? 1 : 0)
      return Response.json({ tasks: rows.slice(0, LIST).map(taskOf), more: rows.length > LIST })
    },

    task(project: string, id: string) {
      const row = getTask(project, id) ?? refuse(`no task ${id} in this project`, 404, "not_found")
      return Response.json(readOf(row))
    },

    change(project: string, id: string, body: Fields, person: string) {
      const state = oneOf(body.state, STATES, "state")
      // A note that is empty once cut counts as none.
      const note = body.note === undefined || body.note === null ? null : visible(body.note, "note").trim() || null
      if (note !== null && [...note].length > 500) refuse("note: must be at most 500 characters")
      if (state === "blocked" && !note) refuse("note: blocked needs a note of at least 1 character")
      const by = byOf(body.by)
      const caller = { person, role: by.role, chat: by.chat }
      return db
        .transaction(() => {
          const row = getTask(project, id) ?? refuse(`no task ${id} in this project`, 404, "not_found")
          const worker = state === "active" ? JSON.stringify(caller) : row.worker
          // The same state and note again changes nothing, unless another caller sets it active.
          if (row.state === state && row.note === note && row.worker === worker)
            return Response.json({ task: taskOf(row) })
          const now = Date.now()
          db.run("insert into task_change (project, task, state, note, by, at) values (?, ?, ?, ?, ?, ?)", [
            project,
            row.id,
            state,
            note,
            JSON.stringify(caller),
            now,
          ])
          const changed = db
            .query<
              TaskRow,
              (string | number | null)[]
            >("update task set state = ?, note = ?, worker = ?, changed = ? where seq = ? returning *")
            .get(state, note, worker, now, row.seq)!
          return Response.json({ task: taskOf(changed) })
        })
        .immediate()
    },

    recall(project: string, id: string) {
      return Response.json({ recall: recallOf(getRecall(project, id)) })
    },

    recalls(project: string, params: URLSearchParams) {
      const limit = params.has("limit") ? Number(params.get("limit")) : 100
      if (!/^\d+$/.test(params.get("limit") ?? "100") || limit < 1 || limit > 500)
        refuse("limit: must be a whole number from 1 to 500")
      // A cursor carries the filters of the first request and where it stopped.
      const cursor = params.has("cursor") ? cursorOf(params.get("cursor")!) : undefined
      const from = cursor?.from ?? (params.has("from") ? params.get("from")! : "0")
      if (!/^\d+$/.test(from)) refuse("from: must be Unix milliseconds")
      const kind = cursor
        ? cursor.kind
        : params.has("kind")
          ? oneOf(params.get("kind"), ["search", "start"], "kind")
          : null
      const rows = db
        .query<RecallRow, (string | number | null)[]>(
          `select * from recall where project = ? and seq > ? and at >= ? and at >= ? and (? is null or kind = ?)
           order by seq limit ?`,
        )
        .all(project, cursor?.seq ?? 0, Number(from), Date.now() - KEPT_MS, kind, kind, limit + 1)
      const page = rows.slice(0, limit)
      return Response.json({
        recalls: page.map(recallOf),
        next:
          rows.length > limit
            ? Buffer.from(JSON.stringify({ seq: page.at(-1)!.seq, from, kind })).toString("base64url")
            : null,
      })
    },

    after(project: string, id: string, body: Fields) {
      const step = body.step === undefined || body.step === null ? null : said(body.step, "step", STEP)
      const person = body.person === undefined || body.person === null ? null : said(body.person, "person", PERSON)
      if (step === null && person === null) refuse("step, person: a body needs step, person or both")
      const acted = actedOf(body.acted)
      byOf(body.by)
      return db
        .transaction(() => {
          const row = getRecall(project, id)
          const entries: string[] = JSON.parse(row.entries)
          const stranger = acted.find((item) => !entries.includes(item.id))
          if (stranger) refuse(`acted: entry ${stranger.id} is not among the entries this recall returned`)
          const now = Date.now()
          const after: After = row.after
            ? JSON.parse(row.after)
            : { step: null, acted: null, person: null, step_at: null, person_at: null }
          // Each part is kept once: the first that comes, with its time.
          const next: After = {
            ...after,
            ...(step !== null && after.step === null ? { step, acted, step_at: now } : {}),
            ...(person !== null && after.person === null ? { person, person_at: now } : {}),
          }
          const changed = { ...row, after: JSON.stringify(next) }
          db.run("update recall set after = ? where seq = ?", [changed.after, row.seq])
          return Response.json({ recall: recallOf(changed) })
        })
        .immediate()
    },

    label(project: string, id: string, body: Fields) {
      if (typeof body.judge !== "string" || ![...body.judge].length || [...body.judge].length > 100)
        refuse("judge: must be 1 to 100 characters")
      const judge = body.judge
      if (!Array.isArray(body.entries)) refuse("entries: must be a list of {id, label}")
      const labelled = body.entries.map((item) => {
        if (!isFields(item) || typeof item.id !== "string") refuse("entries: each must be {id, label}")
        return { id: item.id, label: oneOf(item.label, LABELS, "entries.label") }
      })
      if (new Set(labelled.map((item) => item.id)).size !== labelled.length)
        refuse("entries: an entry is labelled at most once")
      const corrected = body.corrected === undefined || body.corrected === null ? null : body.corrected
      if (
        corrected !== null &&
        (typeof corrected !== "string" || ![...corrected].length || [...corrected].length > 300)
      )
        refuse("corrected: must be null or 1 to 300 characters")
      if (corrected !== null && /[\n\r\u0085\u2028\u2029]/.test(corrected)) refuse("corrected: must be on one line")
      byOf(body.by)
      return db
        .transaction(() => {
          const row = getRecall(project, id)
          const entries: string[] = JSON.parse(row.entries)
          const stranger = labelled.find((item) => !entries.includes(item.id))
          if (stranger) refuse(`entries: entry ${stranger.id} is not among the entries this recall returned`)
          // One set per judge: a judge's second set replaces its first.
          const others = (JSON.parse(row.labels) as Labels[]).filter((set) => set.judge !== judge)
          if (others.length >= JUDGES) refuse(`judge: a recall has labels of at most ${JUDGES} judges`)
          const labels = JSON.stringify([...others, { judge, entries: labelled, corrected, at: Date.now() }])
          db.run("update recall set labels = ? where seq = ?", [labels, row.seq])
          return Response.json({ recall: recallOf({ ...row, labels }) })
        })
        .immediate()
    },

    stop() {
      stopped = true
    },
  }

  /** A row of the recall log that is still kept, or 404. */
  function getRecall(project: string, id: string) {
    return (
      db
        .query<RecallRow, (string | number)[]>("select * from recall where project = ? and id = ? and at >= ?")
        .get(project, id, Date.now() - KEPT_MS) ?? refuse(`no recall ${id} in this project`, 404, "not_found")
    )
  }

  /** What `search` and `start` answer: the entries, each with its score, whether vectors ranked them, and how many wait for one. */
  async function found(input: { project: string; query: string; scopes: Scopes; kinds: string[]; limit: number }) {
    const vector = (await embed([input.query], QUERY_MS))?.[0]
    const meaning = vector && embedding ? { vector, model: embedding.model } : undefined
    return {
      entries: search<Row>(db, { ...input, meaning }).map((row) => ({ ...entryOf(row), score: row.score })),
      meaning: meaning !== undefined,
      waiting: embedding ? waiting(db, { ...input, model: embedding.model }) : 0,
    }
  }

  /** Vectors of length 1 for `inputs`, in their order, or undefined when the endpoint fails or is too slow. */
  async function embed(inputs: string[], ms: number) {
    if (!embedding) return undefined
    const response = await fetch(`${embedding.url.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(embedding.key ? { authorization: `Bearer ${embedding.key}` } : {}),
      },
      body: JSON.stringify({ model: embedding.model, input: inputs }),
      signal: AbortSignal.timeout(ms),
    }).catch(() => undefined)
    if (!response?.ok) return undefined
    return vectorsOf(await response.json().catch(() => undefined), inputs.length)
  }

  function stored(seq: number, vector: Float32Array) {
    if (stopped) return
    db.run("update entry set vector = ?, vector_model = ? where seq = ? and deleted is null", [
      new Uint8Array(vector.buffer),
      embedding!.model,
      seq,
    ])
  }

  /** Embeds waiting live entries in the background, oldest first, until none wait or a call fails. */
  function catchUp() {
    if (!embedding || catching || stopped) return
    catching = true
    const next = async (): Promise<void> => {
      const rows = db
        .query<
          Row,
          [string]
        >(`select * from entry where ${live} and (vector is null or vector_model is not ?) order by seq limit ${BATCH}`)
        .all(embedding.model)
      if (!rows.length) return
      const vectors = await embed(rows.map(source), ENTRY_MS)
      if (!vectors || stopped) return
      db.transaction(() => rows.forEach((row, index) => stored(row.seq, vectors[index]!)))()
      return next()
    }
    void next()
      .catch(() => undefined)
      .finally(() => {
        catching = false
      })
  }

  /** Logs a search or a start: its scopes and kinds as the request sent them. */
  function logged(
    project: string,
    kind: "search" | "start",
    query: string,
    body: Fields,
    answer: { entries: { id: string }[]; meaning: boolean },
    by: { person: string },
  ) {
    const id = newID()
    db.run(
      `insert into recall (id, project, kind, query, scopes, kinds, entries, meaning, by, at, after, labels)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, '[]')`,
      [
        id,
        project,
        kind,
        query,
        JSON.stringify(body.scopes),
        JSON.stringify(body.kinds ?? null),
        JSON.stringify(answer.entries.map((entry) => entry.id)),
        answer.meaning ? 1 : 0,
        JSON.stringify(by),
        Date.now(),
      ],
    )
    return id
  }
}

function entryOf(row: Row) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    basis: row.basis,
    scope: row.scope,
    role: row.role,
    task: row.task,
    subtask: row.subtask,
    by: JSON.parse(row.by),
    at: row.at,
    supersedes: row.supersedes,
    superseded_by: row.superseded_by,
    deleted: row.deleted === null ? null : JSON.parse(row.deleted),
  }
}

function taskOf(row: TaskRow) {
  return {
    id: row.id,
    parent: row.parent,
    title: row.title,
    description: row.description,
    state: row.state,
    note: row.note,
    by: JSON.parse(row.by),
    worker: row.worker === null ? null : JSON.parse(row.worker),
    at: row.at,
    changed: row.changed,
  }
}

function recallOf(row: RecallRow) {
  return {
    id: row.id,
    kind: row.kind,
    query: row.query,
    scopes: JSON.parse(row.scopes),
    kinds: JSON.parse(row.kinds),
    entries: JSON.parse(row.entries),
    meaning: row.meaning === 1,
    by: JSON.parse(row.by),
    at: row.at,
    after: row.after === null ? null : JSON.parse(row.after),
    labels: JSON.parse(row.labels),
  }
}

/** Chat text of what followed a search: kept as sent, only its length checked, in code points. */
function said(value: unknown, field: string, most: number) {
  if (typeof value !== "string" || ![...value].length || [...value].length > most)
    refuse(`${field}: must be 1 to ${most} characters`)
  return value
}

function actedOf(value: unknown) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > READ) refuse(`acted: must be a list of at most ${READ} {id, how}`)
  const acted = value.map((item) => {
    if (!isFields(item) || typeof item.id !== "string") refuse("acted: each must be {id, how}")
    return { id: item.id, how: oneOf(item.how, ACTS, "acted.how") }
  })
  if (new Set(acted.map((item) => item.id)).size !== acted.length) refuse("acted: each entry at most once")
  return acted
}

function cursorOf(value: string) {
  const cursor = (() => {
    try {
      return JSON.parse(Buffer.from(value, "base64url").toString()) as unknown
    } catch {
      return undefined
    }
  })()
  if (
    !isFields(cursor) ||
    typeof cursor.seq !== "number" ||
    typeof cursor.from !== "string" ||
    (cursor.kind !== null && typeof cursor.kind !== "string")
  )
    refuse("cursor: must be the next of an earlier answer")
  return { seq: cursor.seq, from: cursor.from, kind: cursor.kind as string | null }
}

function changeOf(row: ChangeRow) {
  return { state: row.state, note: row.note, by: JSON.parse(row.by), at: row.at }
}

/** What a new entry belongs to, from its `scope` and who writes it. */
function homeOf(scope: unknown, by: { role: string; task: string | null; subtask: string | null }) {
  const value = oneOf(scope, SCOPES, "scope")
  if (value === "global") return { scope: value, role: null, task: null, subtask: null }
  if (value === "role") return { scope: value, role: by.role, task: null, subtask: null }
  if (by.task === null) refuse("by.task: an entry of scope task needs by.task")
  return { scope: value, role: null, task: by.task, subtask: by.subtask }
}

function byOf(value: unknown) {
  if (!isFields(value)) refuse("by: must be an object with role and chat")
  return {
    role: label(value.role, "by.role"),
    chat: label(value.chat, "by.chat"),
    task: value.task === undefined || value.task === null ? null : label(value.task, "by.task"),
    subtask: value.subtask === undefined || value.subtask === null ? null : label(value.subtask, "by.subtask"),
  }
}

function label(value: unknown, field: string) {
  const text = visible(value, field)
  if (!text || [...text].length > 128) refuse(`${field}: must be 1 to 128 characters`)
  if (text.trim() !== text) refuse(`${field}: must not start or end with a space`)
  return text
}

function queryOf(value: unknown, field: string) {
  if (typeof value !== "string") refuse(`${field}: must be a string`)
  if (!value || [...value].length > capabilities.query_characters)
    refuse(`${field}: must be 1 to ${capabilities.query_characters} characters`)
  return value
}

/** What an entry's vector is made from: its text, then its basis on a line of its own. */
function source(row: Row) {
  return row.basis ? `${row.text}\n${row.basis}` : row.text!
}

/** One finite, non-zero vector per input, ordered by `index` and scaled to length 1; otherwise undefined. */
function vectorsOf(body: unknown, count: number) {
  if (!isFields(body) || !Array.isArray(body.data) || body.data.length !== count) return undefined
  const items = body.data
    .filter(isFields)
    .toSorted((a, b) => Number(a.index) - Number(b.index))
    .map((item, index) => (item.index === index && Array.isArray(item.embedding) ? item.embedding : []))
  const vectors = items.map((item) => {
    if (!item.length || !item.every((value) => typeof value === "number" && Number.isFinite(value))) return undefined
    const length = Math.hypot(...item)
    return length > 0 ? Float32Array.from(item, (value) => value / length) : undefined
  })
  if (items.length !== count || !vectors.every((vector) => vector !== undefined)) return undefined
  return vectors
}

function kindsOf(value: unknown) {
  if (value === undefined || value === null) return KINDS
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > KINDS.length ||
    new Set(value).size !== value.length ||
    !value.every((item) => typeof item === "string" && KINDS.includes(item))
  )
    refuse(`kinds: must be null or a list of 1 to 3 different kinds of ${KINDS.join(", ")}`)
  return value.filter((item): item is string => typeof item === "string")
}

function limitOf(value: unknown) {
  if (value === undefined) return 5
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > capabilities.search_limit)
    refuse(`limit: must be a whole number from 1 to ${capabilities.search_limit}`)
  return value
}

function scopesOf(value: unknown): Scopes {
  if (value === "all") return "all"
  if (!isFields(value)) refuse(`scopes: must be "all" or {"global", "roles", "tasks"}`)
  if (value.global !== undefined && typeof value.global !== "boolean") refuse("scopes.global: must be true or false")
  const scopes = {
    global: value.global === true,
    roles: names(value.roles, "scopes.roles"),
    tasks: names(value.tasks, "scopes.tasks"),
  }
  if (!scopes.global && !scopes.roles.length && !scopes.tasks.length) refuse("scopes: selects nothing")
  return scopes
}

function names(value: unknown, field: string) {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    refuse(`${field}: must be a list of strings`)
  return value.filter((item): item is string => typeof item === "string")
}

/** A string without a refused character; a line feed is allowed where `lines` says so. */
function visible(value: unknown, field: string, lines = false) {
  if (typeof value !== "string") refuse(`${field}: must be a string`)
  const points = [...value].map((char) => char.codePointAt(0)!)
  const at = points.findIndex(
    (point) => !(lines && point === 0x0a) && REFUSED.some((range) => point >= range[0] && point <= range[1]),
  )
  if (at >= 0)
    refuse(
      `${field}: refused character U+${points[at].toString(16).toUpperCase().padStart(4, "0")} at position ${at + 1}; ${lines ? "characters a reader cannot see are not allowed" : "characters a reader cannot see and line breaks are not allowed"}`,
    )
  return value
}

function oneOf(value: unknown, list: string[], field: string) {
  if (typeof value !== "string" || !list.includes(value)) refuse(`${field}: must be one of ${list.join(", ")}`)
  return value
}

function projectOf(value: string) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) refuse("project: must be 1 to 128 characters of A-Z a-z 0-9 . _ -")
  return value
}

async function bodyOf(request: Request) {
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > BODY_BYTES) refuse(`body: more than ${BODY_BYTES} bytes`)
  const value: unknown = await new Response(bytes).json().catch(() => refuse("body: is not valid JSON"))
  if (!isFields(value)) refuse("body: must be a JSON object")
  return value
}

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function newID() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => ALPHABET[byte % 32]).join("")
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message)
  }
}

function refuse(message: string, status = 400, type = "invalid_request"): never {
  throw new Refusal(status, type, message)
}

function failure(status: number, type: string, message: string, extra: Fields = {}) {
  return Response.json({ error: { type, message, ...extra } }, { status })
}

if (import.meta.main) {
  const flags = process.argv.slice(2)
  const values = (name: string) => flags.flatMap((flag, index) => (flag === name ? [flags[index + 1]] : []))
  const embedding = values("--embedding-url")[0]
  const served = startMemoryServer({
    port: Number(values("--port")[0] ?? 0),
    file: values("--file")[0],
    embedding: embedding
      ? { url: embedding, model: values("--embedding-model")[0] ?? "", key: values("--embedding-key")[0] }
      : undefined,
    keys: values("--key").map((item) =>
      item.includes("=")
        ? { key: item.slice(0, item.indexOf("=")), label: item.slice(item.indexOf("=") + 1) }
        : { key: item },
    ),
  })
  console.log(`listening ${served.url}`)
}
