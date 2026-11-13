import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { vectorOf, type FakeEmbedding } from "./memory-embedding"

/**
 * The memory API's contract tests (the workspace's `docs/reference/memory-api.md`), as plain HTTP against a base URL,
 * so that the same cases run against the small server and against CLIProxyPacer. Every test works in projects of its
 * own with a random part, so a server that already holds data needs no reset and the tests run in any order.
 *
 * The server calls `embedding.fake` with the model `test-embedding` (and `embedding.key`, when it is set); `bare` is a
 * server without an embedding endpoint, for the cases that need one.
 */
export type Target = {
  readonly url: string
  readonly key: string
  readonly person: string
  readonly second?: { readonly key: string; readonly person: string }
  readonly embedding: { readonly fake: FakeEmbedding; readonly key?: string }
  readonly bare?: string
}

type Entry = {
  id: string
  kind: string
  text: string | null
  basis: string | null
  scope: string
  role: string | null
  task: string | null
  subtask: string | null
  by: { person: string; role: string; chat: string; task: string | null; subtask: string | null }
  at: number
  supersedes: string | null
  superseded_by: string | null
  deleted: null | { at: number; by: { person: string; role: string; chat: string }; reason: string }
}

/** An entry as `search` and `start` answer it. */
type Found = Entry & { score: number }

type Body = {
  entry: Entry
  existing?: boolean
  near: Found[]
  recall: string
  entries: Found[]
  meaning: boolean
  waiting: number
  task: null
  counts: { global: number; role: number; task: number }
  error: { type: string; message: string }
  pacer: { memory: Record<string, unknown> }
}

const ID = /^[0-9abcdefghjkmnpqrstvwxyz]{12}$/
const by = { role: "build", chat: "ses_contract" }
const random = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10)
/** A word no other entry holds, on any server. */
const word = () => `zq${random()}`

/** The contract's refused characters: one from each row and each range end of its table. */
const REFUSED = [
  0x0000, 0x0009, 0x000a, 0x000d, 0x001f, 0x007f, 0x0085, 0x009f, 0x2028, 0x2029, 0x00ad, 0x034f, 0x061c, 0x115f,
  0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x206f, 0x3164, 0xfe00, 0xfe0f,
  0xfeff, 0xffa0, 0xfff0, 0xfff8, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, 0xe0000, 0xe0001, 0xe0fff, 0xfff9, 0xfffb, 0xe000,
  0xf8ff, 0xf0000, 0x10ffff,
]

export function memoryContract(target: Target) {
  const fake = target.embedding.fake
  const send = async (
    method: string,
    path: string,
    body?: unknown,
    key: string | null = target.key,
    url = target.url,
  ) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(key === null ? {} : { authorization: `Bearer ${key}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    })
    const type = response.headers.get("content-type") ?? ""
    const text = await response.text()
    return {
      status: response.status,
      type,
      text,
      body: (type.startsWith("application/json") ? JSON.parse(text) : {}) as Body,
    }
  }

  /** One fresh project and its routes, on the target or on another server (`url`). */
  const project = (name: string, url = target.url) => {
    const id = `contract-${name}-${random()}`
    const base = `/pacer/v1/memory/${id}`
    return {
      id,
      write: (body: Record<string, unknown>, key?: string) => send("POST", `${base}/entries`, body, key, url),
      verified: (text: string, extra: Record<string, unknown> = {}, key?: string) =>
        send(
          "POST",
          `${base}/entries`,
          { kind: "verified", text, basis: "checked by a test", scope: "global", by, ...extra },
          key,
          url,
        ),
      read: (entry: string, key?: string) => send("GET", `${base}/entries/${entry}`, undefined, key, url),
      forget: (entry: string, body: Record<string, unknown> = { reason: "a test forgets it", by }) =>
        send("POST", `${base}/entries/${entry}/forget`, body, undefined, url),
      search: (body: Record<string, unknown>, key?: string) =>
        send("POST", `${base}/search`, { by, ...body }, key, url),
      start: (body: Record<string, unknown>) =>
        send("POST", `${base}/start`, { by, task: null, ...body }, undefined, url),
      export: async () => {
        const answer = await send("GET", `${base}/export`, undefined, undefined, url)
        return {
          ...answer,
          lines: answer.text
            .split("\n")
            .filter((line) => line)
            .map((line) => JSON.parse(line) as Entry & { type: string }),
        }
      },
    }
  }

  const ids = (entries: Entry[]) => entries.map((entry) => entry.id).toSorted()
  /** A written entry as a search answers it: the same, with a score. */
  const scored = (entry: Entry) => ({ ...entry, score: expect.any(Number) })
  const expectInvalid = (answer: { status: number; body: Body }, field: string) => {
    expect(answer.status).toBe(400)
    expect(answer.body.error.type).toBe("invalid_request")
    expect(answer.body.error.message).toContain(field)
  }
  const expectNotFound = (answer: { status: number; body: Body }) => {
    expect(answer.status).toBe(404)
    expect(answer.body.error.type).toBe("not_found")
  }
  /** With the endpoint failing, a search has no meaning and answers by keyword alone. */
  const keywordOnly = () => {
    beforeEach(() => {
      fake.fail = true
    })
    afterEach(() => {
      fake.fail = false
    })
  }

  beforeAll(async () => {
    const memory = (await send("GET", "/pacer/v1/capabilities")).body.pacer?.memory
    if (memory?.embedding !== "test-embedding")
      throw new Error(
        `the server at ${target.url} must call the embedding endpoint ${fake.url} with the model test-embedding; its capabilities say embedding: ${JSON.stringify(memory?.embedding)}`,
      )
  })
  afterEach(() => {
    fake.fail = false
    fake.delay = 0
  })

  describe("auth", () => {
    test("a request without a key is 401", async () => {
      const answer = await send(
        "POST",
        `/pacer/v1/memory/${project("auth").id}/search`,
        { query: "x", scopes: "all", by },
        null,
      )
      expect(answer.status).toBe(401)
      expect(answer.body.error).toBeDefined()
    })

    test("a request with an unknown key is 401", async () => {
      const answer = await send(
        "POST",
        `/pacer/v1/memory/${project("auth").id}/search`,
        { query: "x", scopes: "all", by },
        `unknown-${random()}`,
      )
      expect(answer.status).toBe(401)
      expect(answer.body.error).toBeDefined()
    })

    test("an entry shows the key's person", async () => {
      const answer = await project("auth").verified("The person comes from the key.")
      expect(answer.status).toBe(201)
      expect(answer.body.entry.by.person).toBe(target.person)
    })

    test.if(target.second !== undefined)("two keys are two people who read each other's entries", async () => {
      const second = target.second!
      const memory = project("auth")
      const term = word()
      const first = await memory.verified(`First person's entry ${term}.`)
      const other = await memory.verified(`Second person's entry ${term}.`, {}, second.key)
      expect(other.status).toBe(201)
      expect(other.body.entry.by.person).toBe(second.person)
      expect((await memory.read(other.body.entry.id)).body.entry).toEqual(other.body.entry)
      expect((await memory.read(first.body.entry.id, second.key)).body.entry).toEqual(first.body.entry)
      const found = await memory.search({ query: term, scopes: "all" }, second.key)
      expect(ids(found.body.entries)).toEqual(ids([first.body.entry, other.body.entry]))
    })
  })

  describe("project", () => {
    test("a project with a character outside A-Za-z0-9._- is 400", async () => {
      const answers = await Promise.all(
        ["bad!name", "bad%20name", "caf%C3%A9", "a%2Fb"].map((name) => send("GET", `/pacer/v1/memory/${name}/export`)),
      )
      answers.forEach((answer) => expectInvalid(answer, "project"))
    })

    test("a project of 129 characters is 400", async () => {
      expectInvalid(await send("GET", `/pacer/v1/memory/${"p".repeat(119)}${random()}/export`), "project")
    })

    test("a project of 128 characters is accepted", async () => {
      const name = `${random()}${"p".repeat(118)}`
      const answer = await send("POST", `/pacer/v1/memory/${name}/entries`, {
        kind: "words",
        text: "A project of 128 characters.",
        scope: "global",
        by,
      })
      expect(name.length).toBe(128)
      expect(answer.status).toBe(201)
    })
  })

  describe("write and read back", () => {
    test("each kind is written", async () => {
      const memory = project("kinds")
      const words = await memory.write({ kind: "words", text: "Keep it short.", scope: "global", by })
      const unverified = await memory.write({
        kind: "unverified",
        text: "It is cached.",
        basis: "the second call was fast",
        scope: "global",
        by,
      })
      const verified = await memory.write({
        kind: "verified",
        text: "The port is 3674.",
        basis: "ss -ltn",
        scope: "global",
        by,
      })
      expect([words.status, unverified.status, verified.status]).toEqual([201, 201, 201])
      expect(words.body.entry).toMatchObject({ kind: "words", text: "Keep it short.", basis: "" })
      expect(unverified.body.entry).toMatchObject({ kind: "unverified", basis: "the second call was fast" })
      expect(verified.body.entry).toMatchObject({ kind: "verified", basis: "ss -ltn" })
    })

    test("every field of a written entry, and the same read back", async () => {
      const memory = project("fields")
      const written = await memory.write({
        kind: "verified",
        text: "The workspace repository has no git remote.",
        basis: "git remote -v printed nothing",
        scope: "global",
        by: { role: "build", chat: "ses_fields" },
      })
      expect(written.status).toBe(201)
      expect(written.body.existing).toBeUndefined()
      const entry = written.body.entry
      expect(entry.id).toMatch(ID)
      expect(Math.abs(entry.at - Date.now())).toBeLessThan(60_000)
      expect(entry).toEqual({
        id: entry.id,
        kind: "verified",
        text: "The workspace repository has no git remote.",
        basis: "git remote -v printed nothing",
        scope: "global",
        role: null,
        task: null,
        subtask: null,
        by: { person: target.person, role: "build", chat: "ses_fields", task: null, subtask: null },
        at: entry.at,
        supersedes: null,
        superseded_by: null,
        deleted: null,
      })
      const read = await memory.read(entry.id)
      expect(read.status).toBe(200)
      expect(JSON.parse(read.text)).toEqual({ entry })
    })

    test("scope role belongs to by.role", async () => {
      const answer = await project("role").verified("A role entry.", {
        scope: "role",
        by: { role: "explore", chat: "ses_r" },
      })
      expect(answer.status).toBe(201)
      expect(answer.body.entry).toMatchObject({ scope: "role", role: "explore", task: null, subtask: null })
    })

    test("scope task belongs to by.task and by.subtask", async () => {
      const memory = project("task")
      const answer = await memory.verified("A task entry.", {
        scope: "task",
        by: { role: "general", chat: "ses_t", task: "t8n2task0001", subtask: "s8n2task0002" },
      })
      expect(answer.status).toBe(201)
      expect(answer.body.entry).toMatchObject({
        scope: "task",
        role: null,
        task: "t8n2task0001",
        subtask: "s8n2task0002",
        by: { person: target.person, role: "general", chat: "ses_t", task: "t8n2task0001", subtask: "s8n2task0002" },
      })
      const plain = await memory.verified("A task entry outside a subtask.", {
        scope: "task",
        by: { ...by, task: "t8n2task0001" },
      })
      expect(plain.body.entry).toMatchObject({ task: "t8n2task0001", subtask: null })
    })

    test("scope task without by.task is 400", async () => {
      expectInvalid(await project("task").verified("A task entry without a task.", { scope: "task" }), "by.task")
    })
  })

  describe("checks", () => {
    test("an unknown kind is 400, the old names fact and conclusion too", async () => {
      const memory = project("checks")
      expectInvalid(await memory.verified("An entry.", { kind: "rumour" }), "kind")
      expectInvalid(await memory.verified("A fact.", { kind: "fact" }), "kind")
      expectInvalid(await memory.verified("A conclusion.", { kind: "conclusion" }), "kind")
    })

    test("an empty text and a text of white space only are 400", async () => {
      const memory = project("checks")
      expectInvalid(await memory.verified(""), "text")
      expectInvalid(await memory.verified("   "), "text")
    })

    test("text is stored trimmed", async () => {
      const answer = await project("checks").verified("   Trimmed on both ends.  ")
      expect(answer.status).toBe(201)
      expect(answer.body.entry.text).toBe("Trimmed on both ends.")
    })

    test("an unverified and a verified entry without a basis are 400", async () => {
      const memory = project("checks")
      expectInvalid(await memory.write({ kind: "unverified", text: "No basis.", scope: "global", by }), "basis")
      expectInvalid(await memory.write({ kind: "verified", text: "No basis.", scope: "global", by }), "basis")
      expectInvalid(
        await memory.write({ kind: "verified", text: "Empty basis.", basis: "", scope: "global", by }),
        "basis",
      )
    })

    test("words with a basis are 400", async () => {
      expectInvalid(
        await project("checks").write({ kind: "words", text: "Keep it.", basis: "said so", scope: "global", by }),
        "basis",
      )
    })

    test("800 code points over text and basis are accepted, 801 refused, one outside the BMP counting as one", async () => {
      const memory = project("size")
      const exact = await memory.verified("😀".repeat(400), { basis: "b".repeat(400) })
      expect(exact.status).toBe(201)
      expect(exact.body.entry.text).toBe("😀".repeat(400))
      expectInvalid(await memory.verified("😀".repeat(400), { basis: "b".repeat(401) }), "text")
      expectInvalid(await memory.write({ kind: "words", text: "w".repeat(801), scope: "global", by }), "text")
      expect((await memory.write({ kind: "words", text: "w".repeat(800), scope: "global", by })).status).toBe(201)
    })

    const refusedIn = {
      text: (memory: ReturnType<typeof project>, char: string) => memory.verified(`Before${char}after.`),
      basis: (memory: ReturnType<typeof project>, char: string) =>
        memory.verified("A verified entry.", { basis: `seen${char}there` }),
      "by.role": (memory: ReturnType<typeof project>, char: string) =>
        memory.verified("A verified entry.", { by: { role: `bu${char}ild`, chat: "ses_c" } }),
    }
    test.each(Object.keys(refusedIn) as (keyof typeof refusedIn)[])(
      "a refused character in %s is 400 and the message names the field",
      async (field) => {
        const memory = project("refused")
        const answers = await Promise.all(REFUSED.map((point) => refusedIn[field](memory, String.fromCodePoint(point))))
        answers.forEach((answer) => expectInvalid(answer, field))
        expect((await memory.export()).lines).toEqual([])
      },
    )

    test("a refused character in a forget reason is 400 and the message names the field", async () => {
      const memory = project("refused")
      const entry = (await memory.verified("An entry to keep.")).body.entry
      const answers = await Promise.all(
        REFUSED.map((point) => memory.forget(entry.id, { reason: `held${String.fromCodePoint(point)}it`, by })),
      )
      answers.forEach((answer) => expectInvalid(answer, "reason"))
      expect((await memory.read(entry.id)).body.entry.deleted).toBeNull()
    })

    test("characters next to the refused ones are accepted", async () => {
      const memory = project("visible")
      const answers = await Promise.all(
        [
          0x0020, 0x00a0, 0x00ae, 0x2010, 0x2030, 0x3165, 0xfe10, 0xfffc, 0x1bca4, 0x1d17b, 0x1f600, 0xe1000, 0xf900,
        ].map((point, index) => memory.verified(`Visible ${index}: a${String.fromCodePoint(point)}b.`)),
      )
      answers.forEach((answer) => expect(answer.status).toBe(201))
    })

    test("a body over 64 KB is 400", async () => {
      expectInvalid(await project("body").verified("A large body.", { padding: "x".repeat(64 * 1024) }), "")
    })

    test("malformed JSON is 400", async () => {
      expectInvalid(await send("POST", `/pacer/v1/memory/${project("body").id}/entries`, '{"kind": "verified",'), "")
    })
  })

  describe("exact copy", () => {
    test("the same text where it belongs to the same thing answers the first entry and stores nothing", async () => {
      const memory = project("copy")
      const first = await memory.verified("The same text.")
      const again = await memory.write({
        kind: "unverified",
        text: "  The same text. ",
        basis: "another basis",
        scope: "global",
        by: { role: "general", chat: "ses_other" },
      })
      expect(again.status).toBe(200)
      expect(JSON.parse(again.text)).toEqual({ entry: first.body.entry, existing: true, near: [] })
      expect((await memory.export()).lines.length).toBe(1)
    })

    test("the same text in another scope, another role or another task is a new entry", async () => {
      const memory = project("copy")
      const text = "The same text everywhere."
      const answers = [
        await memory.verified(text),
        await memory.verified(text, { scope: "role", by: { role: "build", chat: "ses_c" } }),
        await memory.verified(text, { scope: "role", by: { role: "explore", chat: "ses_c" } }),
        await memory.verified(text, { scope: "task", by: { ...by, task: "t1copy" } }),
        await memory.verified(text, { scope: "task", by: { ...by, task: "t2copy" } }),
      ]
      expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201])
      expect(new Set(answers.map((answer) => answer.body.entry.id)).size).toBe(5)
      expect((await memory.export()).lines.length).toBe(5)
    })
  })

  describe("replace", () => {
    test("a replacement belongs to what the replaced entry belonged to, and by is the replacer", async () => {
      const memory = project("replace")
      const role = (await memory.verified("Old role entry.", { scope: "role", by: { role: "build", chat: "ses_a" } }))
        .body.entry
      const task = (
        await memory.verified("Old task entry.", {
          scope: "task",
          by: { role: "general", chat: "ses_a", task: "t1", subtask: "s1" },
        })
      ).body.entry
      const roleNew = await memory.verified("New role entry.", {
        scope: "global",
        supersedes: role.id,
        by: { role: "general", chat: "ses_b" },
      })
      const taskNew = await memory.verified("New task entry.", {
        scope: "role",
        supersedes: task.id,
        by: { role: "explore", chat: "ses_b", task: "t9", subtask: "s9" },
      })
      expect([roleNew.status, taskNew.status]).toEqual([201, 201])
      expect(roleNew.body.entry).toMatchObject({
        scope: "role",
        role: "build",
        task: null,
        subtask: null,
        supersedes: role.id,
        superseded_by: null,
        by: { person: target.person, role: "general", chat: "ses_b", task: null, subtask: null },
      })
      expect(taskNew.body.entry).toMatchObject({
        scope: "task",
        role: null,
        task: "t1",
        subtask: "s1",
        supersedes: task.id,
        by: { person: target.person, role: "explore", chat: "ses_b", task: "t9", subtask: "s9" },
      })
      expect((await memory.read(role.id)).body.entry).toEqual({ ...role, superseded_by: roleNew.body.entry.id })
      expect((await memory.read(roleNew.body.entry.id)).body.entry).toEqual(roleNew.body.entry)
    })

    test("a replacement can be replaced: a chain of three", async () => {
      const memory = project("replace")
      const one = (await memory.verified("Version one.")).body.entry
      const two = (await memory.verified("Version two.", { supersedes: one.id })).body.entry
      const three = await memory.verified("Version three.", { supersedes: two.id })
      expect(three.status).toBe(201)
      expect(three.body.entry.supersedes).toBe(two.id)
      expect((await memory.read(one.id)).body.entry.superseded_by).toBe(two.id)
      expect((await memory.read(two.id)).body.entry).toMatchObject({
        supersedes: one.id,
        superseded_by: three.body.entry.id,
      })
    })

    test("replacing an already replaced entry is 409 and names the entry that replaced it", async () => {
      const memory = project("replace")
      const one = (await memory.verified("Replaced once.")).body.entry
      const two = (await memory.verified("The replacement.", { supersedes: one.id })).body.entry
      const again = await memory.verified("A second replacement.", { supersedes: one.id })
      expect(again.status).toBe(409)
      expect(again.body.error.type).toBe("conflict")
      expect(again.body.error.message).toContain(two.id)
    })

    test("replacing a deleted entry is 409", async () => {
      const memory = project("replace")
      const one = (await memory.verified("Deleted, then replaced.")).body.entry
      await memory.forget(one.id)
      const answer = await memory.verified("The replacement.", { supersedes: one.id })
      expect(answer.status).toBe(409)
      expect(answer.body.error.type).toBe("conflict")
    })

    test("replacing an unknown id is 404", async () => {
      expectNotFound(await project("replace").verified("Replaces nothing.", { supersedes: "000000000000" }))
    })
  })

  describe("a replacement and its copies", () => {
    test("the same text with another kind and basis replaces the entry it names, and sent twice answers the replacement", async () => {
      const memory = project("same-text")
      const text = `The gate opens at ${word()}.`
      const guess = (await memory.write({ kind: "unverified", text, basis: "a guess", scope: "global", by })).body.entry
      const body = { kind: "verified", text, basis: "opened it", scope: "global", by, supersedes: guess.id }
      const checked = await memory.write(body)
      expect(checked.status).toBe(201)
      expect(checked.body.existing).toBeUndefined()
      expect(checked.body.entry).toMatchObject({ kind: "verified", text, basis: "opened it", supersedes: guess.id })
      expect((await memory.read(guess.id)).body.entry).toEqual({ ...guess, superseded_by: checked.body.entry.id })
      const again = await memory.write(body)
      expect(again.status).toBe(200)
      expect(JSON.parse(again.text)).toEqual({ entry: checked.body.entry, existing: true, near: [] })
      expect((await memory.export()).lines.length).toBe(2)
    })

    test("with the copy in the same place the named entry is replaced by the copy, and nothing is written", async () => {
      const memory = project("copy-replaces")
      const term = word()
      const first = (await memory.verified(`The gate was shut ${term}.`)).body.entry
      // The copy is itself a replacement, so that its own supersedes is seen to stay.
      const copy = (await memory.verified(`The gate holds ${term}.`, { supersedes: first.id })).body.entry
      const named = (await memory.verified(`The gate held ${term} once.`)).body.entry
      const answer = await memory.write({
        kind: "unverified",
        text: `The gate holds ${term}.`,
        basis: "another basis",
        scope: "role",
        by: { role: "explore", chat: "ses_other" },
        supersedes: named.id,
      })
      expect(answer.status).toBe(200)
      expect(JSON.parse(answer.text)).toEqual({ entry: copy, existing: true, near: [] })
      expect((await memory.read(named.id)).body.entry).toEqual({ ...named, superseded_by: copy.id })
      expect((await memory.read(copy.id)).body.entry).toEqual(copy)
      expect((await memory.export()).lines.map((line) => line.id)).toEqual([first.id, copy.id, named.id])
      expect(ids((await memory.search({ query: term, scopes: "all", limit: 20 })).body.entries)).toEqual([copy.id])
    })

    test("with the named entry already replaced or deleted the answer is the copy and nothing changes", async () => {
      const memory = project("copy-late")
      const text = `The gate holds ${word()}.`
      const copy = (await memory.verified(text)).body.entry
      const replaced = (await memory.verified("The gate is shut.")).body.entry
      const replacement = (await memory.verified("The gate is open.", { supersedes: replaced.id })).body.entry
      const deleted = (await memory.verified("The gate is gone.")).body.entry
      const forgotten = (await memory.forget(deleted.id)).body.entry
      const before = (await memory.export()).lines
      for (const named of [replaced.id, deleted.id]) {
        const answer = await memory.verified(text, { supersedes: named })
        expect(answer.status).toBe(200)
        expect(JSON.parse(answer.text)).toEqual({ entry: copy, existing: true, near: [] })
      }
      expect((await memory.read(replaced.id)).body.entry.superseded_by).toBe(replacement.id)
      expect((await memory.read(deleted.id)).body.entry).toEqual(forgotten)
      expect((await memory.export()).lines).toEqual(before)
    })

    test("with the same text in another scope or role a new entry is written where the named entry belongs", async () => {
      const memory = project("copy-elsewhere")
      const text = `The gate holds ${word()}.`
      const role = (await memory.verified(text, { scope: "role" })).body.entry
      const explore = (await memory.verified(text, { scope: "role", by: { role: "explore", chat: "ses_e" } })).body
        .entry
      const named = (await memory.verified("The gate held something else.")).body.entry
      const answer = await memory.verified(text, { scope: "role", supersedes: named.id })
      expect(answer.status).toBe(201)
      expect(answer.body.existing).toBeUndefined()
      expect(answer.body.entry).toMatchObject({ text, scope: "global", role: null, supersedes: named.id })
      expect([role.id, explore.id]).not.toContain(answer.body.entry.id)
      expect((await memory.read(named.id)).body.entry.superseded_by).toBe(answer.body.entry.id)
      expect((await memory.read(role.id)).body.entry).toEqual(role)
      expect((await memory.export()).lines.length).toBe(4)
    })
  })

  describe("a replacement that moves", () => {
    const explore = { role: "explore", chat: "ses_explore" }

    test("a role entry moved to global is global, the old one replaced, and another role's search finds the new one", async () => {
      const memory = project("move-global")
      const term = word()
      const old = (await memory.verified(`The port is ${term} old.`, { scope: "role" })).body.entry
      const moved = await memory.verified(`The port is ${term} new.`, {
        scope: "global",
        move: true,
        supersedes: old.id,
      })
      expect(moved.status).toBe(201)
      expect(moved.body.entry).toMatchObject({
        scope: "global",
        role: null,
        task: null,
        subtask: null,
        supersedes: old.id,
        superseded_by: null,
      })
      expect((await memory.read(old.id)).body.entry).toEqual({ ...old, superseded_by: moved.body.entry.id })
      const found = await memory.search({ query: term, scopes: { global: true, roles: ["explore"] }, by: explore })
      expect(ids(found.body.entries)).toEqual([moved.body.entry.id])
    })

    test("a global entry moved to role belongs to by.role", async () => {
      const memory = project("move-role")
      const old = (await memory.verified("A global entry to move.")).body.entry
      const moved = await memory.verified("A role entry now.", {
        scope: "role",
        move: true,
        supersedes: old.id,
        by: explore,
      })
      expect(moved.status).toBe(201)
      expect(moved.body.entry).toMatchObject({ scope: "role", role: "explore", task: null, supersedes: old.id })
      expect((await memory.read(old.id)).body.entry.superseded_by).toBe(moved.body.entry.id)
    })

    test("moved to task it belongs to by.task and by.subtask; without by.task it is 400 and nothing changes", async () => {
      const memory = project("move-task")
      const old = (await memory.verified("A global entry for a task.")).body.entry
      const refused = await memory.verified("A task entry without a task.", {
        scope: "task",
        move: true,
        supersedes: old.id,
      })
      expectInvalid(refused, "by.task")
      expect((await memory.read(old.id)).body.entry).toEqual(old)
      const moved = await memory.verified("A task entry now.", {
        scope: "task",
        move: true,
        supersedes: old.id,
        by: { ...by, task: "t1move", subtask: "s1move" },
      })
      expect(moved.status).toBe(201)
      expect(moved.body.entry).toMatchObject({ scope: "task", role: null, task: "t1move", subtask: "s1move" })
      expect((await memory.read(old.id)).body.entry.superseded_by).toBe(moved.body.entry.id)
      expect((await memory.export()).lines.length).toBe(2)
    })

    test("move without scope is 400, and a move that is not a boolean or null is 400", async () => {
      const memory = project("move-checks")
      const old = (await memory.verified("An entry that stays.")).body.entry
      expectInvalid(
        await memory.write({ kind: "words", text: "No scope.", by, move: true, supersedes: old.id }),
        "scope",
      )
      expectInvalid(await memory.verified("A string move.", { move: "true", supersedes: old.id }), "move")
      expectInvalid(await memory.verified("A number move.", { move: 1, supersedes: old.id }), "move")
      expect((await memory.export()).lines).toEqual([{ type: "entry", ...old }])
    })

    test("move false or null is as absent: the replacement stays where the replaced entry was", async () => {
      const memory = project("move-absent")
      for (const move of [false, null]) {
        const old = (await memory.verified(`A role entry, move ${move}.`, { scope: "role" })).body.entry
        const answer = await memory.verified(`Its replacement, move ${move}.`, {
          scope: "global",
          move,
          supersedes: old.id,
        })
        expect(answer.status).toBe(201)
        expect(answer.body.entry).toMatchObject({ scope: "role", role: "build", supersedes: old.id })
      }
    })

    test("move without supersedes writes a new entry where scope says", async () => {
      const answer = await project("move-new").verified("A new entry with move.", {
        scope: "role",
        move: true,
        by: explore,
      })
      expect(answer.status).toBe(201)
      expect(answer.body.entry).toMatchObject({ scope: "role", role: "explore", supersedes: null })
    })

    test("move to the place the entry is in is an ordinary replacement, and the named entry is never its own copy", async () => {
      const memory = project("move-same")
      const text = `The gate holds ${word()}.`
      const old = (await memory.verified(text, { scope: "role", kind: "unverified", basis: "a guess" })).body.entry
      const answer = await memory.verified(text, { scope: "role", move: true, supersedes: old.id })
      expect(answer.status).toBe(201)
      expect(answer.body.existing).toBeUndefined()
      expect(answer.body.entry).toMatchObject({ text, scope: "role", role: "build", supersedes: old.id })
      expect(answer.body.entry.id).not.toBe(old.id)
      expect((await memory.read(old.id)).body.entry).toEqual({ ...old, superseded_by: answer.body.entry.id })
    })

    test("with a copy in the target place the named entry is replaced by the copy, and nothing is written", async () => {
      const memory = project("move-copy")
      const text = `The gate holds ${word()}.`
      const copy = (await memory.verified(text)).body.entry
      const named = (await memory.verified("The gate held something else.", { scope: "role" })).body.entry
      const before = (await memory.export()).lines.length
      const answer = await memory.verified(text, { scope: "global", move: true, supersedes: named.id })
      expect(answer.status).toBe(200)
      expect(JSON.parse(answer.text)).toEqual({ entry: copy, existing: true, near: [] })
      expect((await memory.read(named.id)).body.entry).toEqual({ ...named, superseded_by: copy.id })
      expect((await memory.read(copy.id)).body.entry).toEqual(copy)
      expect((await memory.export()).lines.length).toBe(before)
    })

    test("a copy in the replaced entry's own place is no copy when move goes elsewhere", async () => {
      const memory = project("move-copy-left")
      const text = `The gate holds ${word()}.`
      const left = (await memory.verified(text, { scope: "role" })).body.entry
      const named = (await memory.verified("The gate held something else.", { scope: "role" })).body.entry
      const answer = await memory.verified(text, { scope: "global", move: true, supersedes: named.id })
      expect(answer.status).toBe(201)
      expect(answer.body.existing).toBeUndefined()
      expect(answer.body.entry).toMatchObject({ text, scope: "global", role: null, supersedes: named.id })
      expect(answer.body.entry.id).not.toBe(left.id)
      expect((await memory.read(named.id)).body.entry.superseded_by).toBe(answer.body.entry.id)
      expect((await memory.read(left.id)).body.entry).toEqual(left)
      expect((await memory.export()).lines.length).toBe(3)
    })

    test("the named entry deleted or already replaced is 409, or the copy when the target place has one", async () => {
      const memory = project("move-late")
      const text = `The gate holds ${word()}.`
      const copy = (await memory.verified(text)).body.entry
      const replaced = (await memory.verified("The gate is shut.", { scope: "role" })).body.entry
      const replacement = (await memory.verified("The gate is open.", { supersedes: replaced.id })).body.entry
      const deleted = (await memory.verified("The gate is gone.", { scope: "role" })).body.entry
      const forgotten = (await memory.forget(deleted.id)).body.entry
      const before = (await memory.export()).lines
      for (const named of [replaced.id, deleted.id]) {
        const conflict = await memory.verified("The gate is elsewhere.", {
          scope: "global",
          move: true,
          supersedes: named,
        })
        expect(conflict.status).toBe(409)
        expect(conflict.body.error.type).toBe("conflict")
        const answer = await memory.verified(text, { scope: "global", move: true, supersedes: named })
        expect(answer.status).toBe(200)
        expect(JSON.parse(answer.text)).toEqual({ entry: copy, existing: true, near: [] })
      }
      expect((await memory.read(replaced.id)).body.entry.superseded_by).toBe(replacement.id)
      expect((await memory.read(deleted.id)).body.entry).toEqual(forgotten)
      expect((await memory.export()).lines).toEqual(before)
    })
  })

  describe("near", () => {
    /** The cosine of two texts' vectors, as the fake endpoint makes them (the tests' basis holds no concept word). */
    const alike = (a: string, b: string) => {
      const [x, y] = [vectorOf(a), vectorOf(b)]
      const dot = x.reduce((sum, value, index) => sum + value * y[index]!, 0)
      return dot / (Math.hypot(...x) * Math.hypot(...y))
    }

    test("a write answers the 3 nearest live entries, best first, each with the cosine as its score", async () => {
      const memory = project("near")
      // Cosine with "image photo picture": a 0.9978, b 0.7073, d 0.0033, c 0.0011.
      const texts = { a: "A picture.", b: "A picture in the terminal.", c: "terminal console shell", d: "A database." }
      const written = Object.fromEntries(
        await Promise.all(
          Object.entries(texts).map(async ([name, text]) => [name, (await memory.verified(text)).body.entry] as const),
        ),
      )
      const answer = await memory.verified("image photo picture")
      expect(answer.status).toBe(201)
      expect(answer.body.near.map((entry) => entry.id)).toEqual([written.a!.id, written.b!.id, written.d!.id])
      expect(answer.body.near[0]).toEqual({ ...written.a!, score: expect.any(Number) })
      answer.body.near.forEach((entry) => expect(entry.score).toBeCloseTo(alike(entry.text!, "image photo picture"), 4))
      expect(answer.body.near.map((entry) => entry.id)).not.toContain(answer.body.entry.id)
    })

    test("never the entry itself, nor a replaced, a deleted or another project's entry", async () => {
      const memory = project("near-live")
      const elsewhere = project("near-live")
      const old = (await memory.verified("A picture, first.")).body.entry
      const replacement = (await memory.verified("A picture, second.", { supersedes: old.id })).body.entry
      const gone = (await memory.verified("A picture, third.")).body.entry
      await memory.forget(gone.id)
      await elsewhere.verified("A picture, elsewhere.")
      const far = (await memory.verified("A console.")).body.entry
      const before = (await memory.verified("A photo, to be replaced.")).body.entry
      const answer = await memory.verified("An image.", { supersedes: before.id })
      expect(answer.status).toBe(201)
      expect(answer.body.near.map((entry) => entry.id)).toEqual([replacement.id, far.id])
    })

    test("entries of every scope, role and kind are in it", async () => {
      const memory = project("near-scopes")
      const all = [
        (await memory.write({ kind: "words", text: "Show the picture.", scope: "global", by })).body.entry,
        (
          await memory.write({
            kind: "unverified",
            text: "An image is cached.",
            basis: "a guess",
            scope: "role",
            by: { role: "explore", chat: "ses_e" },
          })
        ).body.entry,
        (await memory.verified("A photo of the gate.", { scope: "task", by: { ...by, task: "t1near" } })).body.entry,
      ]
      const answer = await memory.verified("A screenshot of the gate.", { scope: "role" })
      expect(ids(answer.body.near)).toEqual(ids(all))
    })

    test("with equal cosines the nearer scope comes first, then the newer entry", async () => {
      const memory = project("near-ties")
      // Written nearest scope first, so that "newer first" alone would give the opposite order.
      const task = (await memory.verified("A picture, task.", { scope: "task", by: { ...by, task: "t1" } })).body.entry
      const role = (await memory.verified("A picture, role.", { scope: "role" })).body.entry
      const global = (await memory.verified("A picture, global.")).body.entry
      const answer = await memory.verified("An image.")
      expect(answer.body.near.map((entry) => entry.id)).toEqual([task.id, role.id, global.id])

      const dated = project("near-ties")
      const older = (await dated.verified("A console, older.")).body.entry
      const newer = (await dated.verified("A console, newer.")).body.entry
      expect((await dated.verified("A shell.")).body.near.map((entry) => entry.id)).toEqual([newer.id, older.id])
    })

    test("an exact copy answers no near entries", async () => {
      const memory = project("near-copy")
      await memory.verified("A photo.")
      await memory.verified("A picture.")
      const answer = await memory.verified("A picture.")
      expect(answer.status).toBe(200)
      expect(answer.body.near).toEqual([])
    })

    test.if(target.bare !== undefined)("a server without an endpoint answers no near entries", async () => {
      const memory = project("near-bare", target.bare)
      await memory.verified("A photo.")
      const answer = await memory.verified("A picture.")
      expect(answer.status).toBe(201)
      expect(answer.body.near).toEqual([])
    })

    test("the endpoint failing or slower than 2 seconds for the write: no near entries, the entry is stored", async () => {
      const memory = project("near-down")
      await memory.verified("A photo.")
      fake.fail = true
      const failed = await memory.verified("A picture.")
      fake.fail = false
      fake.delay = 3000
      const slow = await memory.verified("An image.")
      fake.delay = 0
      for (const answer of [failed, slow]) {
        expect(answer.status).toBe(201)
        expect(answer.body.near).toEqual([])
        expect((await memory.read(answer.body.entry.id)).body.entry).toEqual(answer.body.entry)
      }
    })
  })

  describe("forget", () => {
    test("text and basis go, and deleted says who, when and why", async () => {
      const memory = project("forget")
      const entry = (await memory.verified("Held a token.", { basis: "printed it" })).body.entry
      const answer = await memory.forget(entry.id, { reason: "held a token", by: { role: "general", chat: "ses_f" } })
      expect(answer.status).toBe(200)
      const deleted = answer.body.entry.deleted!
      expect(Math.abs(deleted.at - Date.now())).toBeLessThan(60_000)
      expect(answer.body.entry).toEqual({
        ...entry,
        text: null,
        basis: null,
        deleted: {
          at: deleted.at,
          by: { person: target.person, role: "general", chat: "ses_f" },
          reason: "held a token",
        },
      })
      expect((await memory.read(entry.id)).body).toEqual(answer.body)
    })

    test("a reason missing, empty or of 201 characters is 400; 200 is accepted", async () => {
      const memory = project("forget")
      const entry = (await memory.verified("Forget me.")).body.entry
      expectInvalid(await memory.forget(entry.id, { by }), "reason")
      expectInvalid(await memory.forget(entry.id, { reason: "", by }), "reason")
      expectInvalid(await memory.forget(entry.id, { reason: "r".repeat(201), by }), "reason")
      const answer = await memory.forget(entry.id, { reason: "r".repeat(200), by })
      expect(answer.status).toBe(200)
      expect(answer.body.entry.deleted?.reason).toBe("r".repeat(200))
    })

    test("forgetting again answers 200 and the same deletion", async () => {
      const memory = project("forget")
      const entry = (await memory.verified("Forget me twice.")).body.entry
      const first = await memory.forget(entry.id)
      const again = await memory.forget(entry.id, { reason: "another reason", by: { role: "general", chat: "ses_g" } })
      expect(again.status).toBe(200)
      expect(again.body).toEqual(first.body)
    })

    test("forgetting a replacement leaves the entry it replaced replaced", async () => {
      const memory = project("forget")
      const term = word()
      const one = (await memory.verified(`Old ${term}.`)).body.entry
      const two = (await memory.verified(`New ${term}.`, { supersedes: one.id })).body.entry
      expect((await memory.forget(two.id)).status).toBe(200)
      expect((await memory.read(one.id)).body.entry).toMatchObject({
        text: `Old ${term}.`,
        superseded_by: two.id,
        deleted: null,
      })
      expect((await memory.search({ query: term, scopes: "all" })).body.entries).toEqual([])
    })

    test("forgetting a replaced entry works and leaves its replacement live", async () => {
      const memory = project("forget")
      const term = word()
      const one = (await memory.verified(`Old ${term}.`)).body.entry
      const two = (await memory.verified(`New ${term}.`, { supersedes: one.id })).body.entry
      const answer = await memory.forget(one.id)
      expect(answer.status).toBe(200)
      expect(answer.body.entry).toMatchObject({ text: null, basis: null, superseded_by: two.id })
      expect(ids((await memory.search({ query: term, scopes: "all" })).body.entries)).toEqual([two.id])
    })

    test("forgetting an unknown id is 404", async () => {
      expectNotFound(await project("forget").forget("000000000000"))
    })
  })

  describe("across projects", () => {
    test("an entry of one project is unknown in another for read, forget and replace", async () => {
      const a = project("across")
      const b = project("across")
      const entry = (await a.verified("Project A's entry.")).body.entry
      expectNotFound(await b.read(entry.id))
      expectNotFound(await b.forget(entry.id))
      expectNotFound(await b.verified("Replaces A's entry from B.", { supersedes: entry.id }))
      expect((await a.read(entry.id)).body.entry).toEqual(entry)
    })

    test("another project's search, start, counts and export never show it", async () => {
      const a = project("across")
      const b = project("across")
      const term = word()
      await a.verified(`Project A holds ${term}.`)
      await a.verified(`Project A's role holds ${term}.`, { scope: "role" })
      const own = (await b.verified(`Project B holds ${term}.`)).body.entry
      const scopes = { global: true, roles: ["build"], tasks: [] }
      expect(ids((await b.search({ query: term, scopes: "all" })).body.entries)).toEqual([own.id])
      const start = await b.start({ prompt: term, scopes })
      expect(ids(start.body.entries)).toEqual([own.id])
      expect(start.body.counts).toEqual({ global: 1, role: 0, task: 0 })
      expect((await b.export()).lines.map((line) => line.id)).toEqual([own.id])
    })
  })

  describe("search by keyword", () => {
    keywordOnly()

    test("finds an entry by a word in its text and by one in its basis", async () => {
      const memory = project("search")
      const inText = word()
      const inBasis = word()
      const entry = (await memory.verified(`The service holds ${inText}.`, { basis: `read it in ${inBasis}` })).body
        .entry
      await memory.verified("Another entry without the words.")
      const byText = await memory.search({ query: `where is ${inText}`, scopes: "all" })
      expect(byText.status).toBe(200)
      expect(byText.body.meaning).toBe(false)
      expect(byText.body.entries).toEqual([scored(entry)])
      expect((await memory.search({ query: inBasis, scopes: "all" })).body.entries).toEqual([scored(entry)])
    })

    test("a replaced and a deleted entry are never returned, the replacement is", async () => {
      const memory = project("search")
      const term = word()
      const replaced = (await memory.verified(`Old ${term}.`)).body.entry
      const replacement = (await memory.verified(`New ${term}.`, { supersedes: replaced.id })).body.entry
      const deleted = (await memory.verified(`Gone ${term}.`, { basis: `basis ${term}` })).body.entry
      await memory.forget(deleted.id)
      const answer = await memory.search({ query: `${term} old gone`, scopes: "all", limit: 20 })
      expect(ids(answer.body.entries)).toEqual([replacement.id])
    })

    describe("scopes are a union", () => {
      const memory = project("scopes")
      const term = word()
      const written: Record<string, Entry> = {}
      beforeAll(async () => {
        const rows = {
          global: { scope: "global" },
          build: { scope: "role", by: { role: "build", chat: "ses_s" } },
          explore: { scope: "role", by: { role: "explore", chat: "ses_s" } },
          t1s1: { scope: "task", by: { role: "general", chat: "ses_s", task: "t1", subtask: "s1" } },
          t1s2: { scope: "task", by: { role: "general", chat: "ses_s", task: "t1", subtask: "s2" } },
          t2: { scope: "task", by: { role: "general", chat: "ses_s", task: "t2" } },
        }
        for (const [name, extra] of Object.entries(rows))
          written[name] = (await memory.verified(`Entry ${name} holds ${term}.`, extra)).body.entry
      })
      const found = async (scopes: unknown) => {
        const answer = await memory.search({ query: term, scopes, limit: 20 })
        expect(answer.status).toBe(200)
        return ids(answer.body.entries)
      }
      const of = (...names: string[]) => ids(names.map((name) => written[name]))

      test("only global", async () => {
        expect(await found({ global: true })).toEqual(of("global"))
        expect(await found({ global: true, roles: [], tasks: [] })).toEqual(of("global"))
      })
      test("only one role", async () => {
        expect(await found({ global: false, roles: ["build"], tasks: [] })).toEqual(of("build"))
      })
      test("only one task, with all its subtasks", async () => {
        expect(await found({ global: false, roles: [], tasks: ["t1"] })).toEqual(of("t1s1", "t1s2"))
      })
      test("two of them together", async () => {
        expect(await found({ global: true, roles: ["explore"], tasks: [] })).toEqual(of("global", "explore"))
        expect(await found({ global: false, roles: ["build"], tasks: ["t2"] })).toEqual(of("build", "t2"))
      })
      test("another role or task only when asked for", async () => {
        expect(await found({ global: false, roles: ["build", "explore"], tasks: ["t1", "t2"] })).toEqual(
          of("build", "explore", "t1s1", "t1s2", "t2"),
        )
      })
      test("all", async () => {
        expect(await found("all")).toEqual(of("global", "build", "explore", "t1s1", "t1s2", "t2"))
      })
    })

    test("scopes selecting nothing are 400", async () => {
      const memory = project("search")
      expectInvalid(
        await memory.search({ query: "anything", scopes: { global: false, roles: [], tasks: [] } }),
        "scopes",
      )
      expectInvalid(await memory.search({ query: "anything", scopes: {} }), "scopes")
    })

    test("limit defaults to 5 and 20 is accepted; 0 and 21 are 400", async () => {
      const memory = project("limit")
      const term = word()
      for (const index of Array.from({ length: 7 }, (_, index) => index))
        await memory.verified(`Entry ${index} ${term}.`)
      expect((await memory.search({ query: term, scopes: "all" })).body.entries.length).toBe(5)
      const twenty = await memory.search({ query: term, scopes: "all", limit: 20 })
      expect(twenty.status).toBe(200)
      expect(twenty.body.entries.length).toBe(7)
      expectInvalid(await memory.search({ query: term, scopes: "all", limit: 0 }), "limit")
      expectInvalid(await memory.search({ query: term, scopes: "all", limit: 21 }), "limit")
    })

    test("a query of 2,000 characters is accepted, 2,001 and an empty one are 400", async () => {
      const memory = project("query")
      const accepted = await memory.search({ query: "😀".repeat(1000) + "q".repeat(1000), scopes: "all" })
      expect(accepted.status).toBe(200)
      expectInvalid(await memory.search({ query: "q".repeat(2001), scopes: "all" }), "query")
      expectInvalid(await memory.search({ query: "", scopes: "all" }), "query")
    })

    test("a query whose words no entry holds answers no entries", async () => {
      const memory = project("search")
      await memory.verified("An entry about something else.")
      const answer = await memory.search({ query: `${word()} ${word()}`, scopes: "all" })
      expect(answer.status).toBe(200)
      expect(answer.body.entries).toEqual([])
      expect(answer.body.recall).toMatch(ID)
    })

    test("more of the query's words come first, and an entry under 0.6 of the best score is cut", async () => {
      const memory = project("rank")
      // Each word is in one entry only, and ten other entries keep the word statistics away from a tiny store's.
      const terms = Array.from({ length: 8 }, word)
      for (const index of Array.from({ length: 10 }, (_, index) => index))
        await memory.verified(`Other entry ${index}.`)
      const four = (await memory.verified(`${terms.slice(0, 4).join(" ")}.`)).body.entry
      const three = (await memory.verified(`${terms.slice(4, 7).join(" ")} plain.`)).body.entry
      await memory.verified(`${terms[7]} plain text here.`)
      const answer = await memory.search({ query: terms.join(" "), scopes: "all", limit: 20 })
      expect(answer.body.meaning).toBe(false)
      expect(answer.body.entries.map((entry) => entry.id)).toEqual([four.id, three.id])
      const scores = answer.body.entries.map((entry) => entry.score)
      expect(scores[1]).toBeGreaterThan(0)
      expect(scores[0]).toBeGreaterThan(scores[1])
    })

    test("with equal scores the nearer scope comes first, then the newer entry", async () => {
      const memory = project("ties")
      const term = word()
      const text = `The gate holds ${term}.`
      // Written nearest scope first, so that "newer first" alone would give the opposite order.
      const task = (await memory.verified(text, { scope: "task", by: { ...by, task: "t1" } })).body.entry
      const role = (await memory.verified(text, { scope: "role" })).body.entry
      const global = (await memory.verified(text)).body.entry
      const scopes = { global: true, roles: ["build"], tasks: ["t1"] }
      const scoped = await memory.search({ query: term, scopes })
      expect(scoped.body.meaning).toBe(false)
      expect(scoped.body.entries.map((entry) => entry.id)).toEqual([task.id, role.id, global.id])

      const other = word()
      const older = (await memory.verified(`Left ${other} right.`)).body.entry
      const newer = (await memory.verified(`Right ${other} left.`)).body.entry
      const dated = await memory.search({ query: other, scopes: "all" })
      expect(dated.body.entries.map((entry) => entry.id)).toEqual([newer.id, older.id])
    })

    test("an entry whose text the query contains is left out, and the cut starts from the best one left", async () => {
      const memory = project("contained")
      const term = word()
      const quoted = (await memory.verified(`Remember ${term} for later.`)).body.entry
      const other = (await memory.verified(`${term} matters here.`)).body.entry
      const alone = await memory.search({ query: `remember ${term} later`, scopes: "all" })
      expect(alone.body.meaning).toBe(false)
      expect(alone.body.entries.map((entry) => entry.id)).toEqual([quoted.id])
      const answer = await memory.search({ query: `Please note: REMEMBER   ${term} for later. Thanks`, scopes: "all" })
      expect(answer.body.entries.map((entry) => entry.id)).toEqual([other.id])
    })

    test("a word with 's finds the word", async () => {
      const memory = project("possessive")
      const term = word()
      const entry = (await memory.verified(`The check of ${term} took long.`)).body.entry
      const answer = await memory.search({ query: `${term}'s`, scopes: "all" })
      expect(answer.body.entries).toEqual([scored(entry)])
    })

    test("every search answers a new recall id", async () => {
      const memory = project("recall")
      const answers = await Promise.all([1, 2, 3].map(() => memory.search({ query: "anything", scopes: "all" })))
      answers.forEach((answer) => expect(answer.body.recall).toMatch(ID))
      expect(new Set(answers.map((answer) => answer.body.recall)).size).toBe(3)
    })
  })

  describe("start", () => {
    test("entries are the search of the prompt in the scopes, at most 5, and task is null", async () => {
      const memory = project("start")
      const term = word()
      for (const index of Array.from({ length: 7 }, (_, index) => index))
        await memory.verified(`Start entry ${index} holds ${term}.`, index % 3 ? {} : { scope: "role" })
      await memory.verified(`An explore entry holds ${term}.`, {
        scope: "role",
        by: { role: "explore", chat: "ses_e" },
      })
      const scopes = { global: true, roles: ["build"], tasks: [] }
      const prompt = `Which entry holds ${term}?`
      const start = await memory.start({ prompt, scopes })
      const search = await memory.search({ query: prompt, scopes, limit: 5 })
      expect(start.status).toBe(200)
      expect(start.body.entries.length).toBe(5)
      expect(start.body.entries).toEqual(search.body.entries)
      expect(start.body.task).toBeNull()
      expect(start.body.recall).toMatch(ID)
      expect(start.body.recall).not.toBe(search.body.recall)
    })

    test("limit defaults to 5 and 20 is accepted; 0 and 21 are 400; entries equal search's with the same limit", async () => {
      const memory = project("start-limit")
      const term = word()
      for (const index of Array.from({ length: 22 }, (_, index) => index))
        await memory.verified(`Entry ${index} holds ${term}${" again".repeat(index % 4)}.`)
      expect((await memory.start({ prompt: term, scopes: "all" })).body.entries.length).toBe(5)
      const start = await memory.start({ prompt: term, scopes: "all", limit: 20 })
      expect(start.status).toBe(200)
      expect(start.body.entries.length).toBe(20)
      expect(start.body.entries).toEqual((await memory.search({ query: term, scopes: "all", limit: 20 })).body.entries)
      const three = await memory.start({ prompt: `${term} again`, scopes: "all", limit: 3 })
      expect(three.body.entries).toEqual(
        (await memory.search({ query: `${term} again`, scopes: "all", limit: 3 })).body.entries,
      )
      expectInvalid(await memory.start({ prompt: term, scopes: "all", limit: 0 }), "limit")
      expectInvalid(await memory.start({ prompt: term, scopes: "all", limit: 21 }), "limit")
    })

    test("counts count live entries of global, of the listed roles and of the listed tasks", async () => {
      const memory = project("counts")
      const replaced = (await memory.verified("Global one.")).body.entry
      await memory.verified("Global one, corrected.", { supersedes: replaced.id })
      await memory.verified("Global two.")
      await memory.verified("Build one.", { scope: "role", by: { role: "build", chat: "ses_c" } })
      const deleted = (await memory.verified("Build two.", { scope: "role", by: { role: "build", chat: "ses_c" } }))
        .body.entry
      await memory.forget(deleted.id)
      await memory.verified("Explore one.", { scope: "role", by: { role: "explore", chat: "ses_c" } })
      await memory.verified("Review one.", { scope: "role", by: { role: "review", chat: "ses_c" } })
      await memory.verified("Task one, first subtask.", { scope: "task", by: { ...by, task: "t1", subtask: "s1" } })
      await memory.verified("Task one, second subtask.", { scope: "task", by: { ...by, task: "t1", subtask: "s2" } })
      await memory.verified("Task two.", { scope: "task", by: { ...by, task: "t2" } })
      await memory.verified("Task three.", { scope: "task", by: { ...by, task: "t3" } })
      const start = await memory.start({
        prompt: "counts",
        scopes: { global: true, roles: ["build", "explore"], tasks: ["t1", "t2"] },
      })
      expect(start.status).toBe(200)
      expect(start.body.counts).toEqual({ global: 2, role: 2, task: 3 })
      const narrow = await memory.start({
        prompt: "counts",
        scopes: { global: true, roles: ["review"], tasks: ["t3"] },
      })
      expect(narrow.body.counts).toEqual({ global: 2, role: 1, task: 1 })
    })
  })

  describe("keys", () => {
    keywordOnly()

    test("keys are no field: sent with a write they change nothing and no answer has them", async () => {
      const memory = project("keys")
      const term = word()
      const written = await memory.verified("The meter table.", { keys: `meters ${term}` })
      expect(written.status).toBe(201)
      expect(written.body.entry).not.toHaveProperty("keys")
      expect((await memory.read(written.body.entry.id)).body.entry).not.toHaveProperty("keys")
      expect((await memory.search({ query: term, scopes: "all" })).body.entries).toEqual([])
      const found = await memory.search({ query: "meter", scopes: "all" })
      expect(found.body.entries).toEqual([scored(written.body.entry)])
      expect(found.body.entries[0]).not.toHaveProperty("keys")
      expect((await memory.export()).lines[0]).not.toHaveProperty("keys")
    })
  })

  describe("meaning", () => {
    /** Polls `search` until no entry of the selection waits for a vector, for at most 5 seconds. */
    const settled = async (search: () => ReturnType<ReturnType<typeof project>["search"]>, deadline: number) => {
      const answer = await search()
      if (answer.body.waiting === 0 || Date.now() > deadline) return answer
      return settled(search, deadline)
    }

    test("the endpoint gets the model, the key, an entry's text and basis, and the query as it is", async () => {
      const memory = project("embed")
      const term = word()
      await memory.verified(`The meter ${term} is read.`, { basis: `seen in ${term}.log` })
      await memory.write({ kind: "words", text: `Say ${term} twice.`, scope: "global", by })
      const query = `  Where is ${term}?  `
      expect((await memory.search({ query, scopes: "all" })).body.meaning).toBe(true)
      const sent = fake.calls.flatMap((call) => call.input).filter((text) => text.includes(term))
      expect(new Set(sent)).toEqual(
        new Set([`The meter ${term} is read.\nseen in ${term}.log`, `Say ${term} twice.`, query]),
      )
      fake.calls.forEach((call) => {
        expect(call.model).toBe("test-embedding")
        expect(call.authorization).toBe(target.embedding.key === undefined ? null : `Bearer ${target.embedding.key}`)
      })
    })

    test("an entry is found by a query that shares a concept and no word with it", async () => {
      const memory = project("concept")
      const near = (await memory.verified("A screenshot of the login page.")).body.entry
      await memory.verified("The console prints nothing.")
      const answer = await memory.search({ query: "Show me the picture", scopes: "all" })
      expect(answer.body.meaning).toBe(true)
      expect(answer.body.waiting).toBe(0)
      expect(answer.body.entries).toEqual([scored(near)])
    })

    test("the merged order and scores", async () => {
      const memory = project("merged")
      const one = word()
      const two = word()
      // The query is about pictures (concept 1). Cosine with it, each text with the basis "checked by a test":
      //   p "<one> <two> terminal"  0.01 / 1.01                     = 0.009901
      //   q "<one> picture"         1.01 / 1.01                     = 1
      //   r "image photo"           2.01 / √(4.01 × 1.01)           = 0.998765
      //   s "console shell"         0.01 / √(4.01 × 1.01)           = 0.004969
      // Meaning brought to 0..1 (low s, high q): q 1, r 0.998759, p 0.004957, s 0.
      // Keyword list: p holds both words, q one; brought to 0..1: p 1, q 0; r and s are not in it.
      // Merged 0.4 × keyword + 0.6 × meaning: q 0.6, r 0.599255, p 0.402974, s 0.
      // The cut keeps what is at least 0.5 × 0.6 = 0.3: q, r, p.
      const p = (await memory.verified(`${one} ${two} terminal`)).body.entry
      const q = (await memory.verified(`${one} picture`)).body.entry
      const r = (await memory.verified("image photo")).body.entry
      await memory.verified("console shell")
      const answer = await memory.search({ query: `${one} ${two} screenshot`, scopes: "all", limit: 20 })
      expect(answer.body.meaning).toBe(true)
      expect(answer.body.entries.map((entry) => entry.id)).toEqual([q.id, r.id, p.id])
      const scores = answer.body.entries.map((entry) => entry.score)
      expect(scores[0]).toBeCloseTo(0.6, 4)
      expect(scores[1]).toBeCloseTo(0.599255, 4)
      expect(scores[2]).toBeCloseTo(0.402974, 4)
      expect(scores[0]).toBeLessThanOrEqual(1)
      expect(scores[0]).toBeGreaterThan(scores[1]!)
      expect(scores[1]).toBeGreaterThan(scores[2]!)
    })

    test("an entry in one list only comes back within the cut, and one under 0.5 of the best does not", async () => {
      const memory = project("cut")
      const one = word()
      // Query about pictures; meaning brought to 0..1: q 1, r 0.998759, u 0.446244, s 0; keyword list: q alone, 1.
      // Merged: q 1, r 0.599255 (meaning only), u 0.267746, s 0. The cut keeps what is at least 0.5: q and r.
      const q = (await memory.verified(`${one} picture`)).body.entry
      const r = (await memory.verified("image photo")).body.entry
      await memory.verified("terminal picture console")
      await memory.verified("console shell")
      const answer = await memory.search({ query: `${one} screenshot`, scopes: "all", limit: 20 })
      expect(answer.body.meaning).toBe(true)
      expect(answer.body.entries.map((entry) => entry.id)).toEqual([q.id, r.id])
      expect(answer.body.entries[1]!.score).toBeCloseTo(0.599255, 4)
    })

    test("a query of stop words only still answers by meaning", async () => {
      const memory = project("stop")
      const plain = (await memory.verified("Keep it short.")).body.entry
      await memory.verified("console shell terminal")
      const answer = await memory.search({ query: "what is it about", scopes: "all" })
      expect(answer.body.meaning).toBe(true)
      expect(answer.body.entries.map((entry) => entry.id)).toEqual([plain.id])
    })

    test("kinds: only the listed kinds come back", async () => {
      const memory = project("kinds")
      const term = word()
      const words = (await memory.write({ kind: "words", text: `Words ${term}.`, scope: "global", by })).body.entry
      await memory.write({ kind: "unverified", text: `Unverified ${term}.`, basis: "a guess", scope: "global", by })
      const verified = (await memory.verified(`Verified ${term}.`)).body.entry
      const answer = await memory.search({ query: term, scopes: "all", kinds: ["words", "verified"] })
      expect(ids(answer.body.entries)).toEqual(ids([words, verified]))
      expect((await memory.search({ query: term, scopes: "all", kinds: null })).body.entries.length).toBe(3)
    })

    test("kinds: an empty list, an unknown kind, a repeated kind and a string are 400", async () => {
      const memory = project("kinds")
      const answers = await Promise.all(
        [[], ["fact"], ["verified", "verified"], "verified", ["words", "unverified", "verified", "words"]].map(
          (kinds) => memory.search({ query: "anything", scopes: "all", kinds }),
        ),
      )
      answers.forEach((answer) => expectInvalid(answer, "kinds"))
      expectInvalid(await memory.start({ prompt: "anything", scopes: "all", kinds: [] }), "kinds")
    })

    test("kinds select before anything is ranked", async () => {
      const memory = project("kinds")
      const one = word()
      const two = word()
      // Each of 51 unverified entries holds both words and is about pictures, the verified one holds one word and is
      // about terminals: the unverified ones fill the first 50 of both lists.
      await Promise.all(
        Array.from({ length: 51 }, (_, index) =>
          memory.write({
            kind: "unverified",
            text: `Note ${index}: ${one} ${two} picture`,
            basis: "a guess",
            scope: "global",
            by,
          }),
        ),
      )
      const verified = (await memory.verified(`${one} terminal`)).body.entry
      const answer = await memory.search({ query: `${one} ${two} screenshot`, scopes: "all", kinds: ["verified"] })
      expect(answer.body.meaning).toBe(true)
      expect(ids(answer.body.entries)).toEqual([verified.id])
    })

    test("an entry written while the endpoint fails is found by keyword, waits, and gets its vector later", async () => {
      const memory = project("later")
      const term = word()
      fake.fail = true
      const written = await memory.verified(`The ${term} screenshot is kept.`)
      expect(written.status).toBe(201)
      const keyword = await memory.search({ query: term, scopes: "all" })
      expect(keyword.body.meaning).toBe(false)
      expect(keyword.body.waiting).toBe(1)
      expect(keyword.body.entries).toEqual([scored(written.body.entry)])
      fake.fail = false
      const answer = await settled(() => memory.search({ query: "picture", scopes: "all" }), Date.now() + 5000)
      expect(answer.body.waiting).toBe(0)
      expect(answer.body.meaning).toBe(true)
      expect(answer.body.entries).toEqual([scored(written.body.entry)])
    })

    test("the endpoint failing during a search gives the keyword answer", async () => {
      const memory = project("down")
      const term = word()
      const entry = (await memory.verified(`The ${term} picture.`)).body.entry
      await memory.verified("console shell")
      fake.fail = true
      const started = Date.now()
      const answer = await memory.search({ query: `${term} screenshot`, scopes: "all" })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(answer.body.meaning).toBe(false)
      expect(answer.body.entries).toEqual([scored(entry)])
    })

    test("the endpoint slower than 1 second during a search gives the keyword answer within 2 seconds", async () => {
      const memory = project("slow")
      const term = word()
      const entry = (await memory.verified(`The ${term} picture.`)).body.entry
      await memory.verified("console shell")
      fake.delay = 3000
      const started = Date.now()
      const answer = await memory.search({ query: `${term} screenshot`, scopes: "all" })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(answer.body.meaning).toBe(false)
      expect(answer.body.entries).toEqual([scored(entry)])
    })

    test("a replacement has its own vector", async () => {
      const memory = project("replaced")
      const old = (await memory.verified("A picture of the gate.")).body.entry
      const replacement = (await memory.verified("The console of the gate.", { supersedes: old.id })).body.entry
      const other = (await memory.verified("A photo of the door.")).body.entry
      expect(ids((await memory.search({ query: "screenshot", scopes: "all" })).body.entries)).toEqual([other.id])
      expect(ids((await memory.search({ query: "shell", scopes: "all" })).body.entries)).toEqual([replacement.id])
    })

    test("after forget an entry is found neither by word nor by meaning", async () => {
      const memory = project("forgotten")
      const term = word()
      const gone = (await memory.verified(`The ${term} picture.`)).body.entry
      const other = (await memory.verified("The console is quiet.")).body.entry
      await memory.forget(gone.id)
      const byWord = await memory.search({ query: term, scopes: "all" })
      const byMeaning = await memory.search({ query: "screenshot", scopes: "all" })
      expect([byWord.body.meaning, byMeaning.body.meaning]).toEqual([true, true])
      expect(ids(byWord.body.entries)).toEqual([other.id])
      expect(ids(byMeaning.body.entries)).toEqual([other.id])
    })

    test.if(target.bare !== undefined)("a server without an endpoint has no meaning and nothing waiting", async () => {
      const capabilities = await send("GET", "/pacer/v1/capabilities", undefined, target.key, target.bare)
      expect(capabilities.body.pacer.memory.embedding).toBeNull()
      const memory = project("bare", target.bare)
      const term = word()
      const entry = (await memory.verified(`The ${term} picture.`)).body.entry
      const answer = await memory.search({ query: term, scopes: "all" })
      expect(answer.body.meaning).toBe(false)
      expect(answer.body.waiting).toBe(0)
      expect(answer.body.entries).toEqual([scored(entry)])
      const start = await memory.start({ prompt: term, scopes: "all" })
      expect([start.body.meaning, start.body.waiting]).toEqual([false, 0])
    })

    test("start answers what search answers: ids, order, scores, meaning and waiting, with kinds too", async () => {
      const memory = project("start-search")
      const term = word()
      await memory.verified(`The ${term} picture.`)
      await memory.verified(`An image of ${term}.`, { scope: "role" })
      await memory.write({ kind: "words", text: `Show the photo of ${term}.`, scope: "global", by })
      await memory.write({
        kind: "unverified",
        text: `${term} has a screenshot.`,
        basis: "a guess",
        scope: "global",
        by,
      })
      await memory.verified("console shell")
      const pick = (body: Body) => ({ entries: body.entries, meaning: body.meaning, waiting: body.waiting })
      const asked = { scopes: { global: true, roles: ["build"], tasks: [] }, kinds: ["verified", "words"], limit: 3 }
      const start = await memory.start({ prompt: `${term} screenshot`, ...asked })
      const search = await memory.search({ query: `${term} screenshot`, ...asked })
      expect(start.body.meaning).toBe(true)
      expect(start.body.entries.length).toBe(3)
      expect(pick(start.body)).toEqual(pick(search.body))
    })
  })

  describe("score", () => {
    test("every entry of search and start has a score above 0", async () => {
      const memory = project("score")
      const term = word()
      for (const index of Array.from({ length: 4 }, (_, index) => index))
        await memory.verified(`Scored ${index} ${term}${" twice".repeat(index)}.`)
      const search = await memory.search({ query: `${term} twice`, scopes: "all" })
      const start = await memory.start({ prompt: `${term} twice`, scopes: "all" })
      expect(search.body.entries.length).toBe(4)
      expect(start.body.entries.length).toBe(4)
      ;[...search.body.entries, ...start.body.entries].forEach((entry) => expect(entry.score).toBeGreaterThan(0))
    })

    test("a written, read, forgotten and exported entry has no score", async () => {
      const memory = project("score")
      const written = (await memory.verified("No score here.")).body.entry
      const read = (await memory.read(written.id)).body.entry
      const forgotten = (await memory.forget(written.id)).body.entry
      const exported = (await memory.export()).lines[0]
      ;[written, read, forgotten, exported].forEach((entry) => expect(entry).not.toHaveProperty("score"))
    })
  })

  test("export: one line per entry in the order stored, replaced entries in full, deleted ones without text", async () => {
    const memory = project("export")
    const one = (await memory.verified("Export one.")).body.entry
    const two = (await memory.verified("Export two.", { scope: "role" })).body.entry
    const three = (await memory.verified("Export three.", { supersedes: one.id })).body.entry
    await memory.forget(two.id)
    const answer = await memory.export()
    expect(answer.status).toBe(200)
    expect(answer.type).toStartWith("application/x-ndjson")
    expect(answer.lines.map((line) => line.type)).toEqual(["entry", "entry", "entry"])
    expect(answer.lines.map((line) => line.id)).toEqual([one.id, two.id, three.id])
    expect(answer.lines[0]).toEqual({ type: "entry", ...one, superseded_by: three.id })
    expect(answer.lines[1]).toEqual({ type: "entry", ...(await memory.read(two.id)).body.entry })
    expect(answer.lines[1]).toMatchObject({ text: null, basis: null })
    expect(answer.lines[2]).toEqual({ type: "entry", ...three })
  })

  describe("concurrent writers", () => {
    test("20 writes of different texts at once make 20 entries", async () => {
      const memory = project("writers")
      const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => memory.verified(`Writer ${index}.`)))
      expect(answers.map((answer) => answer.status)).toEqual(Array.from({ length: 20 }, () => 201))
      expect(new Set(answers.map((answer) => answer.body.entry.id)).size).toBe(20)
      expect((await memory.export()).lines.length).toBe(20)
    })

    test("20 writes of the same text at once make one entry", async () => {
      const memory = project("writers")
      const answers = await Promise.all(Array.from({ length: 20 }, () => memory.verified("The same writer.")))
      expect(answers.filter((answer) => answer.status === 201).length).toBe(1)
      expect(answers.filter((answer) => answer.status === 200 && answer.body.existing === true).length).toBe(19)
      expect(new Set(answers.map((answer) => answer.body.entry.id)).size).toBe(1)
      expect((await memory.export()).lines.length).toBe(1)
    })
  })

  test("capabilities say that the server has memory, with its limits", async () => {
    const answer = await send("GET", "/pacer/v1/capabilities")
    expect(answer.status).toBe(200)
    expect(answer.body.pacer.memory).toEqual({
      version: 1,
      entry_characters: 800,
      query_characters: 2000,
      search_limit: 20,
      embedding: "test-embedding",
    })
  })

  test("an unknown route under /pacer/v1/memory/ is 404 not_found", async () => {
    expectNotFound(await send("GET", `/pacer/v1/memory/${project("routes").id}/nothing`))
    expectNotFound(await send("POST", `/pacer/v1/memory/${project("routes").id}/entries/000000000000/nothing`, {}))
  })
}
