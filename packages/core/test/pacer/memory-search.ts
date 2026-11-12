import type { Database } from "bun:sqlite"

/**
 * How the small memory server matches, merges and cuts entries: the contract's "Search order", kept apart from the
 * server so that it can change on its own. Two lists are made from the selection (the live entries of the scopes and
 * kinds asked for): the keyword list, BM25 over text and basis with equal weights, and, when the query has a vector,
 * the meaning list, cosine similarity with the entries' vectors. Each list's scores are brought to 0..1 and merged
 * with `WEIGHTS`; entries under `CUT` of the best are left out. Without a query vector the keyword list alone is
 * answered, cut at `KEYWORD_CUT`. Reads the server's `entry` table and its FTS5 table `entry_fts`
 * (rowid = `entry.seq`), which holds live entries only.
 */

/** The FTS5 tokenizer of `entry_fts`. */
export const tokenizer = "porter unicode61"

/** How many of the best entries each list holds before the query's own text takes some out. */
export const CANDIDATES = 50

/** What each list's score, brought to 0..1, weighs in the merged score. */
export const WEIGHTS = { keyword: 0.4, meaning: 0.6 }

/** With meaning, an entry is returned only when its merged score is at least this share of the best one's. */
export const CUT = 0.5

/** Without meaning, an entry is returned only when its negated `bm25()` is at least this share of the best one's. */
export const KEYWORD_CUT = 0.6

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

/** The live entries of a project in `scopes` whose kind is one of `kinds`. */
export type Selection = { readonly project: string; readonly scopes: Scopes; readonly kinds: string[] }

/** What the ranking reads of a stored entry. `vector` is a Float32Array of length 1, as bytes. */
type Ranked = {
  readonly id: string
  readonly text: string | null
  readonly scope: string
  readonly at: number
  readonly seq: number
  readonly vector: Uint8Array | null
}

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
 * The entries of the selection that a search answers, best first, each with its `score`: at most `limit`, none whose
 * text the query itself contains (the asker has it already). `meaning` is the query's vector (length 1) and the model
 * that made it; only entries with a vector of that model are in the meaning list.
 */
export function search<Row extends Ranked>(
  db: Database,
  input: Selection & {
    readonly query: string
    readonly limit: number
    readonly meaning?: { readonly vector: Float32Array; readonly model: string }
  },
) {
  const selection = selected(input)
  const asked = plain(input.query)
  const left = <T extends Ranked>(rows: T[]) => rows.filter((row) => !asked.includes(plain(row.text ?? "")))
  const list = words(input.query)
  const keyword = list.length
    ? left(
        db
          .query<Row & { score: number }, (string | number)[]>(
            `select entry.*, -bm25(entry_fts) as score from entry_fts join entry on entry.seq = entry_fts.rowid
             where entry_fts match ? and ${selection.where}
             order by score desc, ${NEARER_SQL}, entry.at desc, entry.seq desc
             limit ${CANDIDATES}`,
          )
          .all(list.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR "), ...selection.values),
      )
    : []
  if (!input.meaning) return keyword.filter((row) => row.score >= keyword[0]!.score * KEYWORD_CUT).slice(0, input.limit)

  const query = input.meaning.vector
  const meaning = left(
    db
      .query<Row, (string | number)[]>(
        `select entry.* from entry where ${selection.where} and entry.vector is not null and entry.vector_model = ?`,
      )
      .all(...selection.values, input.meaning.model)
      .map((row) => ({ ...row, score: cosine(query, row.vector!) }))
      .toSorted(order)
      .slice(0, CANDIDATES),
  )
  const scores = { keyword: normalized(keyword), meaning: normalized(meaning) }
  const merged = [...new Map([...keyword, ...meaning].map((row) => [row.id, row])).values()]
    .map((row) => ({
      ...row,
      score: WEIGHTS.keyword * (scores.keyword.get(row.id) ?? 0) + WEIGHTS.meaning * (scores.meaning.get(row.id) ?? 0),
    }))
    .toSorted(order)
  return merged.filter((row) => row.score >= merged[0]!.score * CUT).slice(0, input.limit)
}

/** How many live entries of the selection have no vector of `model`. */
export function waiting(db: Database, input: Selection & { readonly model: string }) {
  const selection = selected(input)
  return db
    .query<
      { n: number },
      (string | number)[]
    >(`select count(*) as n from entry where ${selection.where} and (entry.vector is null or entry.vector_model is not ?)`)
    .get(...selection.values, input.model)!.n
}

const NEARER: Record<string, number> = { task: 0, role: 1, global: 2 }
const NEARER_SQL = "case entry.scope when 'task' then 0 when 'role' then 1 else 2 end"

/** Best score first; equal scores by the nearer scope, then the newer entry. */
function order(a: Ranked & { score: number }, b: Ranked & { score: number }) {
  return b.score - a.score || NEARER[a.scope]! - NEARER[b.scope]! || b.at - a.at || b.seq - a.seq
}

/** A list's scores brought to 0..1 by its best and worst; all 1 when they are equal. The list is best first. */
function normalized(rows: { id: string; score: number }[]) {
  const high = rows[0]?.score ?? 0
  const low = rows.at(-1)?.score ?? 0
  return new Map(rows.map((row) => [row.id, high === low ? 1 : (row.score - low) / (high - low)]))
}

/** Both vectors have length 1, so the cosine is their dot product. */
function cosine(query: Float32Array, bytes: Uint8Array) {
  const vector = new Float32Array(bytes.slice().buffer)
  return vector.reduce((sum, value, index) => sum + value * (query[index] ?? 0), 0)
}

function selected(input: Selection) {
  return {
    where: `entry.project = ? and entry.superseded_by is null and entry.deleted is null
      and entry.kind in (select value from json_each(?))
      and (? or (entry.scope = 'global' and ?)
        or (entry.scope = 'role' and entry.role in (select value from json_each(?)))
        or (entry.scope = 'task' and entry.task in (select value from json_each(?))))`,
    values: [
      input.project,
      JSON.stringify(input.kinds),
      input.scopes === "all" ? 1 : 0,
      input.scopes !== "all" && input.scopes.global ? 1 : 0,
      JSON.stringify(input.scopes === "all" ? [] : input.scopes.roles),
      JSON.stringify(input.scopes === "all" ? [] : input.scopes.tasks),
    ],
  }
}
