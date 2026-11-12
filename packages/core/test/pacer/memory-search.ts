import type { Database } from "bun:sqlite"

/**
 * How the small memory server matches, orders and cuts entries: the contract's "Search order", kept apart from the
 * server so that it can change on its own. An entry matches when it holds one of the query's words; the order is BM25
 * over text and basis with equal weights, then the nearer scope, then the newer entry; an entry whose score is under
 * `CUT` of the best one's is left out. Reads the server's `entry` table and its FTS5 table `entry_fts`
 * (rowid = `entry.seq`), which holds live entries only.
 */

/** The FTS5 tokenizer of `entry_fts`. */
export const tokenizer = "porter unicode61"

/** A result is returned only when its BM25 score is at least this share of the best result's. */
export const CUT = 0.6

/** How many of the best matches are looked at before the query's own text and the cut take some out. */
export const CANDIDATES = 50

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
 * a leading `/ . _ -` kept (`/pacer/v1/meters`, `.env`); a trailing `'s` cut (`0.0.25's`); lowercased, without stop
 * words, each once.
 */
export function words(query: string) {
  return [
    ...new Set(
      query
        .split(/\s+/)
        .map((piece) =>
          piece
            .replace(/^[^\p{L}\p{N}/._-]+|[^\p{L}\p{N}]+$/gu, "")
            .replace(/['\u2019]s$/iu, "")
            .toLowerCase(),
        )
        .filter((word) => word && !STOP.has(word)),
    ),
  ]
}

/** A text as it is compared with a query: lowercased, every run of white space one space. */
export const plain = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean).join(" ")

/**
 * The live entries of `project` within `scopes` that hold a word of `query`, best first: at most `limit`, none whose
 * text the query itself contains (the asker has it already), and none that scores under `CUT` of the best one left.
 */
export function search<Row extends { readonly text: string | null }>(
  db: Database,
  input: { readonly project: string; readonly query: string; readonly scopes: Scopes; readonly limit: number },
) {
  const list = words(input.query)
  if (!list.length) return []
  const rows = db
    .query<Row & { score: number }, (string | number)[]>(
      `select entry.*, bm25(entry_fts) as score from entry_fts join entry on entry.seq = entry_fts.rowid
       where entry_fts match ? and entry.project = ? and entry.superseded_by is null and entry.deleted is null
         and (? or (entry.scope = 'global' and ?)
           or (entry.scope = 'role' and entry.role in (select value from json_each(?)))
           or (entry.scope = 'task' and entry.task in (select value from json_each(?))))
       order by score, case entry.scope when 'task' then 0 when 'role' then 1 else 2 end, entry.at desc, entry.seq desc
       limit ?`,
    )
    .all(
      list.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR "),
      input.project,
      input.scopes === "all" ? 1 : 0,
      input.scopes !== "all" && input.scopes.global ? 1 : 0,
      JSON.stringify(input.scopes === "all" ? [] : input.scopes.roles),
      JSON.stringify(input.scopes === "all" ? [] : input.scopes.tasks),
      CANDIDATES,
    )
  const asked = plain(input.query)
  const kept = rows.filter((row) => !asked.includes(plain(row.text ?? "")))
  // bm25() is negative and lower is better, so the best row is the first.
  return kept.filter((row) => row.score <= kept[0]!.score * CUT).slice(0, input.limit)
}
