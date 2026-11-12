import { Database } from "bun:sqlite"
import { search, tokenizer, type Scopes } from "./memory-search"

/**
 * The small memory server: the memory API (the workspace's `docs/reference/memory-api.md`) on `Bun.serve` and
 * `bun:sqlite`, for openforge's tests and as the contract in code. Matching and ordering live in `memory-search.ts`.
 *
 * Every write is one SQLite transaction (`BEGIN IMMEDIATE`), and Bun's SQLite is synchronous, so the exact-copy rule
 * and a replacement hold for writers that arrive at once, in this process or another one on the same file.
 *
 * As a script: `bun memory-server.ts --port <n> --key <key>[=<label>] [--key …] [--file <path>]`.
 */

export const capabilities = { version: 1, entry_characters: 800, query_characters: 2000, search_limit: 20 }

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
const BODY_BYTES = 64 * 1024
const KINDS = ["words", "conclusion", "fact"]
const SCOPES = ["global", "role", "task"]

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
    deleted text
  )`,
  `create index if not exists entry_project on entry (project, scope, role, task)`,
  `create virtual table if not exists entry_fts using fts5(text, basis, tokenize="${tokenizer}")`,
  `create table if not exists recall (
    id text primary key,
    project text not null,
    query text not null,
    scopes text not null,
    entries text not null,
    by text not null,
    at integer not null
  )`,
]

/** A stored entry: `by` and `deleted` are JSON. */
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
}

type Fields = Record<string, unknown>

/** Starts the server on 127.0.0.1. A key without a label is the person `key-` and its last four characters. */
export function startMemoryServer(input: {
  readonly keys: ReadonlyArray<{ readonly key: string; readonly label?: string }>
  readonly port?: number
  readonly file?: string
}) {
  const people = new Map(input.keys.map((item) => [item.key, item.label ?? `key-${item.key.slice(-4)}`]))
  const db = new Database(input.file ?? ":memory:", { create: true })
  db.run("pragma journal_mode = wal")
  db.run("pragma busy_timeout = 5000")
  SCHEMA.forEach((statement) => db.run(statement))
  const store = storeOf(db)

  const guarded =
    <R extends Request>(handle: (request: R, person: string) => Response | Promise<Response>) =>
    (request: R) => {
      const key = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1]
      if (!key) return Response.json({ error: "Missing API key" }, { status: 401 })
      const person = people.get(key)
      if (!person) return Response.json({ error: "Invalid API key" }, { status: 401 })
      return handle(request, person)
    }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 0,
    routes: {
      "/pacer/v1/capabilities": {
        GET: guarded(() => Response.json({ pacer: { memory: capabilities }, providers: [], models: [] })),
      },
      "/pacer/v1/memory/:project/entries": {
        POST: guarded(async (request, person) =>
          store.write(projectOf(request.params.project), await bodyOf(request), person),
        ),
      },
      "/pacer/v1/memory/:project/entries/:id": {
        GET: guarded((request) => store.read(projectOf(request.params.project), request.params.id)),
      },
      "/pacer/v1/memory/:project/entries/:id/forget": {
        POST: guarded(async (request, person) =>
          store.forget(projectOf(request.params.project), request.params.id, await bodyOf(request), person),
        ),
      },
      "/pacer/v1/memory/:project/search": {
        POST: guarded(async (request, person) =>
          store.search(projectOf(request.params.project), await bodyOf(request), person),
        ),
      },
      "/pacer/v1/memory/:project/start": {
        POST: guarded(async (request, person) =>
          store.start(projectOf(request.params.project), await bodyOf(request), person),
        ),
      },
      "/pacer/v1/memory/:project/export": {
        GET: guarded((request) => store.export(projectOf(request.params.project))),
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
    stop: async () => {
      await server.stop(true)
      db.close()
    },
  }
}

function storeOf(db: Database) {
  const get = (project: string, id: string) =>
    db.query<Row, string[]>("select * from entry where project = ? and id = ?").get(project, id)
  const live = "superseded_by is null and deleted is null"

  return {
    write(project: string, body: Fields, person: string) {
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

      return db
        .transaction(() => {
          const replaced =
            supersedes === null
              ? undefined
              : (get(project, supersedes) ??
                refuse(`supersedes: no entry ${supersedes} in this project`, 404, "not_found"))
          // A replacement takes what the replaced entry belongs to; the body's scope is ignored.
          const target = replaced
            ? { scope: replaced.scope, role: replaced.role, task: replaced.task, subtask: replaced.subtask }
            : homeOf(body.scope, by)
          // An exact copy is looked for before the replaced entry's state, so a retried replacement answers the entry it made.
          const copy = db
            .query<
              Row,
              (string | null)[]
            >(`select * from entry where project = ? and scope = ? and role is ? and task is ? and text = ? and ${live}`)
            .get(project, target.scope, target.role, target.task, text)
          if (copy) return Response.json({ entry: entryOf(copy), existing: true })
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
          return Response.json({ entry: entryOf(row) }, { status: 201 })
        })
        .immediate()
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
          db.run("update entry set text = null, basis = null, deleted = ? where seq = ?", [
            JSON.stringify(deleted),
            row.seq,
          ])
          db.run("delete from entry_fts where rowid = ?", [row.seq])
          return Response.json({
            entry: entryOf({ ...row, text: null, basis: null, deleted: JSON.stringify(deleted) }),
          })
        })
        .immediate()
    },

    search(project: string, body: Fields, person: string) {
      const query = queryOf(body.query, "query")
      const scopes = scopesOf(body.scopes)
      const limit = body.limit === undefined ? 5 : body.limit
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > capabilities.search_limit)
        refuse(`limit: must be a whole number from 1 to ${capabilities.search_limit}`)
      const by = { person, ...byOf(body.by) }
      const entries = search<Row>(db, { project, query, scopes, limit }).map(entryOf)
      return Response.json({ recall: logged(project, query, scopes, entries, by), entries })
    },

    start(project: string, body: Fields, person: string) {
      const prompt = queryOf(body.prompt, "prompt")
      const scopes = scopesOf(body.scopes)
      if (body.task !== undefined && body.task !== null && typeof body.task !== "string")
        refuse("task: must be a task id or null")
      const by = { person, ...byOf(body.by) }
      const entries = search<Row>(db, { project, query: prompt, scopes, limit: 5 }).map(entryOf)
      // A role entry has no task and a task entry no role, so `coalesce(role, task)` is what each belongs to.
      const count = (scope: string, list: string[] | "all") =>
        db
          .query<{ n: number }, (string | number)[]>(
            `select count(*) as n from entry where project = ? and scope = ? and ${live}
             and (? or coalesce(role, task) in (select value from json_each(?)))`,
          )
          .get(project, scope, list === "all" ? 1 : 0, JSON.stringify(list === "all" ? [] : list))?.n ?? 0
      return Response.json({
        recall: logged(project, prompt, scopes, entries, by),
        entries,
        task: null,
        counts: {
          global: count("global", "all"),
          role: count("role", scopes === "all" ? "all" : scopes.roles),
          task: count("task", scopes === "all" ? "all" : scopes.tasks),
        },
      })
    },

    export(project: string) {
      const lines = db
        .query<Row, string[]>("select * from entry where project = ? order by seq")
        .all(project)
        .map((row) => JSON.stringify({ type: "entry", ...entryOf(row) }) + "\n")
      return new Response(lines.join(""), { headers: { "content-type": "application/x-ndjson" } })
    },
  }

  function logged(project: string, query: string, scopes: Scopes, entries: { id: string }[], by: { person: string }) {
    const id = newID()
    db.run("insert into recall (id, project, query, scopes, entries, by, at) values (?, ?, ?, ?, ?, ?, ?)", [
      id,
      project,
      query,
      JSON.stringify(scopes),
      JSON.stringify(entries.map((entry) => entry.id)),
      JSON.stringify(by),
      Date.now(),
    ])
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

/** A string without a refused character. */
function visible(value: unknown, field: string) {
  if (typeof value !== "string") refuse(`${field}: must be a string`)
  const points = [...value].map((char) => char.codePointAt(0)!)
  const at = points.findIndex((point) => REFUSED.some((range) => point >= range[0] && point <= range[1]))
  if (at >= 0)
    refuse(
      `${field}: refused character U+${points[at].toString(16).toUpperCase().padStart(4, "0")} at position ${at + 1}; characters a reader cannot see and line breaks are not allowed`,
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

function failure(status: number, type: string, message: string) {
  return Response.json({ error: { type, message } }, { status })
}

if (import.meta.main) {
  const flags = process.argv.slice(2)
  const values = (name: string) => flags.flatMap((flag, index) => (flag === name ? [flags[index + 1]] : []))
  const served = startMemoryServer({
    port: Number(values("--port")[0] ?? 0),
    file: values("--file")[0],
    keys: values("--key").map((item) =>
      item.includes("=")
        ? { key: item.slice(0, item.indexOf("=")), label: item.slice(item.indexOf("=") + 1) }
        : { key: item },
    ),
  })
  console.log(`listening ${served.url}`)
}
