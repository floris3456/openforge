import type { Database } from "bun:sqlite"

/**
 * How the small memory server matches and orders entries, kept apart from the server so that the search order can
 * change on its own. Provisional (the contract's "Search order" is still open): every word of the query, OR-ed, ranked
 * by BM25 over text and basis with equal weights, then newer first. Reads the server's `entry` table and its FTS5
 * table `entry_fts` (rowid = `entry.seq`), which holds live entries only.
 */

/** The FTS5 tokenizer of `entry_fts`. */
export const tokenizer = "porter unicode61"

export const STOP = new Set(
  `a an and are as at be been but by can could did do does doing done for from had has have having he her here him his
how i if in into is it its just me my no nor not of on or our out over own she so some such than that the their them
then there these they this those through to too under until up upon us very was we were what when where which while who
whom whose why will with would you your about after again against all am any because before being below between both
during each few further more most other same should only once also may might must shall get got which s t don doesn
didn isn aren wasn weren won wouldn couldn shouldn`.split(/\s+/),
)

/** Which live entries a search looks in: every one of the project, or the union of the global ones, those of the listed roles and those of the listed tasks. */
export type Scopes = "all" | { readonly global: boolean; readonly roles: string[]; readonly tasks: string[] }

/**
 * A query's words: split on white space; outer punctuation cut, inner kept (`0.0.24`, `pings.duration_minutes`), and
 * a leading `/ . _ -` kept (`/pacer/v1/meters`, `.env`); lowercased, without stop words, each once.
 */
export function words(query: string) {
  return [
    ...new Set(
      query
        .split(/\s+/)
        .map((piece) => piece.replace(/^[^\p{L}\p{N}/._-]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase())
        .filter((word) => word && !STOP.has(word)),
    ),
  ]
}

/** The first `limit` live entries of `project` within `scopes` that hold a word of `query`, best first. */
export function search<Row>(
  db: Database,
  input: { readonly project: string; readonly query: string; readonly scopes: Scopes; readonly limit: number },
) {
  const list = words(input.query)
  if (!list.length) return []
  return db
    .query<Row, (string | number)[]>(
      `select entry.* from entry_fts join entry on entry.seq = entry_fts.rowid
       where entry_fts match ? and entry.project = ? and entry.superseded_by is null and entry.deleted is null
         and (? or (entry.scope = 'global' and ?)
           or (entry.scope = 'role' and entry.role in (select value from json_each(?)))
           or (entry.scope = 'task' and entry.task in (select value from json_each(?))))
       order by bm25(entry_fts), entry.at desc, entry.seq desc
       limit ?`,
    )
    .all(
      list.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR "),
      input.project,
      input.scopes === "all" ? 1 : 0,
      input.scopes !== "all" && input.scopes.global ? 1 : 0,
      JSON.stringify(input.scopes === "all" ? [] : input.scopes.roles),
      JSON.stringify(input.scopes === "all" ? [] : input.scopes.tasks),
      input.limit,
    )
}
