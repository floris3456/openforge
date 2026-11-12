import { beforeAll, describe, expect, test } from "bun:test"

/**
 * The memory API's contract tests (the workspace's `docs/reference/memory-api.md`), as plain HTTP against a base URL,
 * so that the same cases run against the small server and against CLIProxyPacer. Every test works in projects of its
 * own with a random part, so a server that already holds data needs no reset and the tests run in any order.
 */
export type Target = {
  readonly url: string
  readonly key: string
  readonly person: string
  readonly second?: { readonly key: string; readonly person: string }
}

type Entry = {
  id: string
  kind: string
  text: string | null
  basis: string | null
  keys: string | null
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
  recall: string
  entries: Found[]
  task: null
  counts: { global: number; role: number; task: number }
  error: { type: string; message: string }
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
  const send = async (method: string, path: string, body?: unknown, key: string | null = target.key) => {
    const response = await fetch(`${target.url}${path}`, {
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

  /** One fresh project and its routes. */
  const project = (name: string) => {
    const id = `contract-${name}-${random()}`
    const base = `/pacer/v1/memory/${id}`
    return {
      id,
      write: (body: Record<string, unknown>, key?: string) => send("POST", `${base}/entries`, body, key),
      fact: (text: string, extra: Record<string, unknown> = {}, key?: string) =>
        send(
          "POST",
          `${base}/entries`,
          { kind: "fact", text, basis: "checked by a test", scope: "global", by, ...extra },
          key,
        ),
      read: (entry: string, key?: string) => send("GET", `${base}/entries/${entry}`, undefined, key),
      forget: (entry: string, body: Record<string, unknown> = { reason: "a test forgets it", by }) =>
        send("POST", `${base}/entries/${entry}/forget`, body),
      search: (body: Record<string, unknown>, key?: string) => send("POST", `${base}/search`, { by, ...body }, key),
      start: (body: Record<string, unknown>) => send("POST", `${base}/start`, { by, task: null, ...body }),
      export: async () => {
        const answer = await send("GET", `${base}/export`)
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
      const answer = await project("auth").fact("The person comes from the key.")
      expect(answer.status).toBe(201)
      expect(answer.body.entry.by.person).toBe(target.person)
    })

    test.if(target.second !== undefined)("two keys are two people who read each other's entries", async () => {
      const second = target.second!
      const memory = project("auth")
      const term = word()
      const first = await memory.fact(`First person's entry ${term}.`)
      const other = await memory.fact(`Second person's entry ${term}.`, {}, second.key)
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
      const conclusion = await memory.write({
        kind: "conclusion",
        text: "It is cached.",
        basis: "the second call was fast",
        scope: "global",
        by,
      })
      const fact = await memory.write({
        kind: "fact",
        text: "The port is 3674.",
        basis: "ss -ltn",
        scope: "global",
        by,
      })
      expect([words.status, conclusion.status, fact.status]).toEqual([201, 201, 201])
      expect(words.body.entry).toMatchObject({ kind: "words", text: "Keep it short.", basis: "" })
      expect(conclusion.body.entry).toMatchObject({ kind: "conclusion", basis: "the second call was fast" })
      expect(fact.body.entry).toMatchObject({ kind: "fact", basis: "ss -ltn" })
    })

    test("every field of a written entry, and the same read back", async () => {
      const memory = project("fields")
      const written = await memory.write({
        kind: "fact",
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
        kind: "fact",
        text: "The workspace repository has no git remote.",
        basis: "git remote -v printed nothing",
        keys: "",
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
      const answer = await project("role").fact("A role entry.", {
        scope: "role",
        by: { role: "explore", chat: "ses_r" },
      })
      expect(answer.status).toBe(201)
      expect(answer.body.entry).toMatchObject({ scope: "role", role: "explore", task: null, subtask: null })
    })

    test("scope task belongs to by.task and by.subtask", async () => {
      const memory = project("task")
      const answer = await memory.fact("A task entry.", {
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
      const plain = await memory.fact("A task entry outside a subtask.", {
        scope: "task",
        by: { ...by, task: "t8n2task0001" },
      })
      expect(plain.body.entry).toMatchObject({ task: "t8n2task0001", subtask: null })
    })

    test("scope task without by.task is 400", async () => {
      expectInvalid(await project("task").fact("A task entry without a task.", { scope: "task" }), "by.task")
    })
  })

  describe("checks", () => {
    test("an unknown kind is 400", async () => {
      expectInvalid(await project("checks").fact("An entry.", { kind: "rumour" }), "kind")
    })

    test("an empty text and a text of white space only are 400", async () => {
      const memory = project("checks")
      expectInvalid(await memory.fact(""), "text")
      expectInvalid(await memory.fact("   "), "text")
    })

    test("text is stored trimmed", async () => {
      const answer = await project("checks").fact("   Trimmed on both ends.  ")
      expect(answer.status).toBe(201)
      expect(answer.body.entry.text).toBe("Trimmed on both ends.")
    })

    test("a conclusion and a fact without a basis are 400", async () => {
      const memory = project("checks")
      expectInvalid(await memory.write({ kind: "conclusion", text: "No basis.", scope: "global", by }), "basis")
      expectInvalid(await memory.write({ kind: "fact", text: "No basis.", scope: "global", by }), "basis")
      expectInvalid(await memory.write({ kind: "fact", text: "Empty basis.", basis: "", scope: "global", by }), "basis")
    })

    test("words with a basis are 400", async () => {
      expectInvalid(
        await project("checks").write({ kind: "words", text: "Keep it.", basis: "said so", scope: "global", by }),
        "basis",
      )
    })

    test("800 code points over text and basis are accepted, 801 refused, one outside the BMP counting as one", async () => {
      const memory = project("size")
      const exact = await memory.fact("😀".repeat(400), { basis: "b".repeat(400) })
      expect(exact.status).toBe(201)
      expect(exact.body.entry.text).toBe("😀".repeat(400))
      expectInvalid(await memory.fact("😀".repeat(400), { basis: "b".repeat(401) }), "text")
      expectInvalid(await memory.write({ kind: "words", text: "w".repeat(801), scope: "global", by }), "text")
      expect((await memory.write({ kind: "words", text: "w".repeat(800), scope: "global", by })).status).toBe(201)
    })

    const refusedIn = {
      text: (memory: ReturnType<typeof project>, char: string) => memory.fact(`Before${char}after.`),
      basis: (memory: ReturnType<typeof project>, char: string) =>
        memory.fact("A fact.", { basis: `seen${char}there` }),
      keys: (memory: ReturnType<typeof project>, char: string) => memory.fact("A fact.", { keys: `seen${char}there` }),
      "by.role": (memory: ReturnType<typeof project>, char: string) =>
        memory.fact("A fact.", { by: { role: `bu${char}ild`, chat: "ses_c" } }),
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
      const entry = (await memory.fact("An entry to keep.")).body.entry
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
        ].map((point, index) => memory.fact(`Visible ${index}: a${String.fromCodePoint(point)}b.`)),
      )
      answers.forEach((answer) => expect(answer.status).toBe(201))
    })

    test("a body over 64 KB is 400", async () => {
      expectInvalid(await project("body").fact("A large body.", { padding: "x".repeat(64 * 1024) }), "")
    })

    test("malformed JSON is 400", async () => {
      expectInvalid(await send("POST", `/pacer/v1/memory/${project("body").id}/entries`, '{"kind": "fact",'), "")
    })
  })

  describe("exact copy", () => {
    test("the same text where it belongs to the same thing answers the first entry and stores nothing", async () => {
      const memory = project("copy")
      const first = await memory.fact("The same text.")
      const again = await memory.write({
        kind: "conclusion",
        text: "  The same text. ",
        basis: "another basis",
        scope: "global",
        by: { role: "general", chat: "ses_other" },
      })
      expect(again.status).toBe(200)
      expect(JSON.parse(again.text)).toEqual({ entry: first.body.entry, existing: true })
      expect((await memory.export()).lines.length).toBe(1)
    })

    test("the same text in another scope, another role or another task is a new entry", async () => {
      const memory = project("copy")
      const text = "The same text everywhere."
      const answers = [
        await memory.fact(text),
        await memory.fact(text, { scope: "role", by: { role: "build", chat: "ses_c" } }),
        await memory.fact(text, { scope: "role", by: { role: "explore", chat: "ses_c" } }),
        await memory.fact(text, { scope: "task", by: { ...by, task: "t1copy" } }),
        await memory.fact(text, { scope: "task", by: { ...by, task: "t2copy" } }),
      ]
      expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201])
      expect(new Set(answers.map((answer) => answer.body.entry.id)).size).toBe(5)
      expect((await memory.export()).lines.length).toBe(5)
    })
  })

  describe("replace", () => {
    test("a replacement belongs to what the replaced entry belonged to, and by is the replacer", async () => {
      const memory = project("replace")
      const role = (await memory.fact("Old role entry.", { scope: "role", by: { role: "build", chat: "ses_a" } })).body
        .entry
      const task = (
        await memory.fact("Old task entry.", {
          scope: "task",
          by: { role: "general", chat: "ses_a", task: "t1", subtask: "s1" },
        })
      ).body.entry
      const roleNew = await memory.fact("New role entry.", {
        scope: "global",
        supersedes: role.id,
        by: { role: "general", chat: "ses_b" },
      })
      const taskNew = await memory.fact("New task entry.", {
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
      const one = (await memory.fact("Version one.")).body.entry
      const two = (await memory.fact("Version two.", { supersedes: one.id })).body.entry
      const three = await memory.fact("Version three.", { supersedes: two.id })
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
      const one = (await memory.fact("Replaced once.")).body.entry
      const two = (await memory.fact("The replacement.", { supersedes: one.id })).body.entry
      const again = await memory.fact("A second replacement.", { supersedes: one.id })
      expect(again.status).toBe(409)
      expect(again.body.error.type).toBe("conflict")
      expect(again.body.error.message).toContain(two.id)
    })

    test("replacing a deleted entry is 409", async () => {
      const memory = project("replace")
      const one = (await memory.fact("Deleted, then replaced.")).body.entry
      await memory.forget(one.id)
      const answer = await memory.fact("The replacement.", { supersedes: one.id })
      expect(answer.status).toBe(409)
      expect(answer.body.error.type).toBe("conflict")
    })

    test("replacing an unknown id is 404", async () => {
      expectNotFound(await project("replace").fact("Replaces nothing.", { supersedes: "000000000000" }))
    })
  })

  describe("forget", () => {
    test("text and basis go, and deleted says who, when and why", async () => {
      const memory = project("forget")
      const entry = (await memory.fact("Held a token.", { basis: "printed it" })).body.entry
      const answer = await memory.forget(entry.id, { reason: "held a token", by: { role: "general", chat: "ses_f" } })
      expect(answer.status).toBe(200)
      const deleted = answer.body.entry.deleted!
      expect(Math.abs(deleted.at - Date.now())).toBeLessThan(60_000)
      expect(answer.body.entry).toEqual({
        ...entry,
        text: null,
        basis: null,
        keys: null,
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
      const entry = (await memory.fact("Forget me.")).body.entry
      expectInvalid(await memory.forget(entry.id, { by }), "reason")
      expectInvalid(await memory.forget(entry.id, { reason: "", by }), "reason")
      expectInvalid(await memory.forget(entry.id, { reason: "r".repeat(201), by }), "reason")
      const answer = await memory.forget(entry.id, { reason: "r".repeat(200), by })
      expect(answer.status).toBe(200)
      expect(answer.body.entry.deleted?.reason).toBe("r".repeat(200))
    })

    test("forgetting again answers 200 and the same deletion", async () => {
      const memory = project("forget")
      const entry = (await memory.fact("Forget me twice.")).body.entry
      const first = await memory.forget(entry.id)
      const again = await memory.forget(entry.id, { reason: "another reason", by: { role: "general", chat: "ses_g" } })
      expect(again.status).toBe(200)
      expect(again.body).toEqual(first.body)
    })

    test("forgetting a replacement leaves the entry it replaced replaced", async () => {
      const memory = project("forget")
      const term = word()
      const one = (await memory.fact(`Old ${term}.`)).body.entry
      const two = (await memory.fact(`New ${term}.`, { supersedes: one.id })).body.entry
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
      const one = (await memory.fact(`Old ${term}.`)).body.entry
      const two = (await memory.fact(`New ${term}.`, { supersedes: one.id })).body.entry
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
      const entry = (await a.fact("Project A's entry.")).body.entry
      expectNotFound(await b.read(entry.id))
      expectNotFound(await b.forget(entry.id))
      expectNotFound(await b.fact("Replaces A's entry from B.", { supersedes: entry.id }))
      expect((await a.read(entry.id)).body.entry).toEqual(entry)
    })

    test("another project's search, start, counts and export never show it", async () => {
      const a = project("across")
      const b = project("across")
      const term = word()
      await a.fact(`Project A holds ${term}.`)
      await a.fact(`Project A's role holds ${term}.`, { scope: "role" })
      const own = (await b.fact(`Project B holds ${term}.`)).body.entry
      const scopes = { global: true, roles: ["build"], tasks: [] }
      expect(ids((await b.search({ query: term, scopes: "all" })).body.entries)).toEqual([own.id])
      const start = await b.start({ prompt: term, scopes })
      expect(ids(start.body.entries)).toEqual([own.id])
      expect(start.body.counts).toEqual({ global: 1, role: 0, task: 0 })
      expect((await b.export()).lines.map((line) => line.id)).toEqual([own.id])
    })
  })

  describe("search", () => {
    test("finds an entry by a word in its text and by one in its basis", async () => {
      const memory = project("search")
      const inText = word()
      const inBasis = word()
      const entry = (await memory.fact(`The service holds ${inText}.`, { basis: `read it in ${inBasis}` })).body.entry
      await memory.fact("Another entry without the words.")
      const byText = await memory.search({ query: `where is ${inText}`, scopes: "all" })
      expect(byText.status).toBe(200)
      expect(byText.body.entries).toEqual([scored(entry)])
      expect((await memory.search({ query: inBasis, scopes: "all" })).body.entries).toEqual([scored(entry)])
    })

    test("a replaced and a deleted entry are never returned, the replacement is", async () => {
      const memory = project("search")
      const term = word()
      const replaced = (await memory.fact(`Old ${term}.`)).body.entry
      const replacement = (await memory.fact(`New ${term}.`, { supersedes: replaced.id })).body.entry
      const deleted = (await memory.fact(`Gone ${term}.`, { basis: `basis ${term}` })).body.entry
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
          written[name] = (await memory.fact(`Entry ${name} holds ${term}.`, extra)).body.entry
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
      for (const index of Array.from({ length: 7 }, (_, index) => index)) await memory.fact(`Entry ${index} ${term}.`)
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
      await memory.fact("An entry about something else.")
      const answer = await memory.search({ query: `${word()} ${word()}`, scopes: "all" })
      expect(answer.status).toBe(200)
      expect(answer.body.entries).toEqual([])
      expect(answer.body.recall).toMatch(ID)
    })

    test("more of the query's words come first, with scores above 0 that fall along the list", async () => {
      const memory = project("rank")
      // Each word is in one entry only, and ten other entries keep the word statistics away from a tiny store's.
      const terms = Array.from({ length: 8 }, word)
      for (const index of Array.from({ length: 10 }, (_, index) => index)) await memory.fact(`Other entry ${index}.`)
      const four = (await memory.fact(`${terms.slice(0, 4).join(" ")}.`)).body.entry
      const three = (await memory.fact(`${terms.slice(4, 7).join(" ")} plain.`)).body.entry
      const one = (await memory.fact(`${terms[7]} plain text here.`)).body.entry
      const answer = await memory.search({ query: terms.join(" "), scopes: "all", limit: 20 })
      expect(answer.body.entries.map((entry) => entry.id)).toEqual([four.id, three.id, one.id])
      const scores = answer.body.entries.map((entry) => entry.score)
      expect(scores[2]).toBeGreaterThan(0)
      expect(scores[1]).toBeGreaterThan(scores[2])
      expect(scores[0]).toBeGreaterThan(scores[1])
    })

    test("with equal scores the nearer scope comes first, then the newer entry", async () => {
      const memory = project("ties")
      const term = word()
      const text = `The gate holds ${term}.`
      // Written nearest scope first, so that "newer first" alone would give the opposite order.
      const task = (await memory.fact(text, { scope: "task", by: { ...by, task: "t1" } })).body.entry
      const role = (await memory.fact(text, { scope: "role" })).body.entry
      const global = (await memory.fact(text)).body.entry
      const scopes = { global: true, roles: ["build"], tasks: ["t1"] }
      const scoped = await memory.search({ query: term, scopes })
      expect(scoped.body.entries.map((entry) => entry.id)).toEqual([task.id, role.id, global.id])

      const other = word()
      const older = (await memory.fact(`Left ${other} right.`)).body.entry
      const newer = (await memory.fact(`Right ${other} left.`)).body.entry
      const dated = await memory.search({ query: other, scopes: "all" })
      expect(dated.body.entries.map((entry) => entry.id)).toEqual([newer.id, older.id])
    })

    test("an entry whose text the query contains is left out", async () => {
      const memory = project("contained")
      const term = word()
      const quoted = (await memory.fact(`Remember ${term} for later.`)).body.entry
      const other = (await memory.fact(`${term} matters here.`)).body.entry
      const alone = await memory.search({ query: `remember ${term} later`, scopes: "all" })
      expect(alone.body.entries.map((entry) => entry.id)).toEqual([quoted.id, other.id])
      const answer = await memory.search({ query: `Please note: REMEMBER   ${term} for later. Thanks`, scopes: "all" })
      expect(answer.body.entries.map((entry) => entry.id)).toEqual([other.id])
    })

    test("a word with 's finds the word", async () => {
      const memory = project("possessive")
      const term = word()
      const entry = (await memory.fact(`The check of ${term} took long.`)).body.entry
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
        await memory.fact(`Start entry ${index} holds ${term}.`, index % 3 ? {} : { scope: "role" })
      await memory.fact(`An explore entry holds ${term}.`, { scope: "role", by: { role: "explore", chat: "ses_e" } })
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
        await memory.fact(`Entry ${index} holds ${term}${" again".repeat(index % 4)}.`)
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
      const replaced = (await memory.fact("Global one.")).body.entry
      await memory.fact("Global one, corrected.", { supersedes: replaced.id })
      await memory.fact("Global two.")
      await memory.fact("Build one.", { scope: "role", by: { role: "build", chat: "ses_c" } })
      const deleted = (await memory.fact("Build two.", { scope: "role", by: { role: "build", chat: "ses_c" } })).body
        .entry
      await memory.forget(deleted.id)
      await memory.fact("Explore one.", { scope: "role", by: { role: "explore", chat: "ses_c" } })
      await memory.fact("Review one.", { scope: "role", by: { role: "review", chat: "ses_c" } })
      await memory.fact("Task one, first subtask.", { scope: "task", by: { ...by, task: "t1", subtask: "s1" } })
      await memory.fact("Task one, second subtask.", { scope: "task", by: { ...by, task: "t1", subtask: "s2" } })
      await memory.fact("Task two.", { scope: "task", by: { ...by, task: "t2" } })
      await memory.fact("Task three.", { scope: "task", by: { ...by, task: "t3" } })
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
    test("keys are written and read back", async () => {
      const memory = project("keys")
      const written = await memory.fact("The meter table.", { keys: "pings duration_minutes billing" })
      expect(written.status).toBe(201)
      expect(written.body.entry.keys).toBe("pings duration_minutes billing")
      expect((await memory.read(written.body.entry.id)).body.entry).toEqual(written.body.entry)
    })

    test("absent keys are empty", async () => {
      const answer = await project("keys").fact("No keys.")
      expect(answer.status).toBe(201)
      expect(answer.body.entry.keys).toBe("")
    })

    test("keys are stored trimmed", async () => {
      expect((await project("keys").fact("Trimmed keys.", { keys: "  one two  " })).body.entry.keys).toBe("one two")
    })

    test("600 code points of keys are accepted, 601 refused, one outside the BMP counting as one", async () => {
      const memory = project("keys")
      const exact = await memory.fact("Long keys.", { keys: "😀".repeat(300) + "k".repeat(300) })
      expect(exact.status).toBe(201)
      expectInvalid(await memory.fact("Too long keys.", { keys: "😀".repeat(300) + "k".repeat(301) }), "keys")
    })

    test("keys do not count towards the 800 characters of text and basis", async () => {
      const answer = await project("keys").fact("t".repeat(400), { basis: "b".repeat(400), keys: "k".repeat(600) })
      expect(answer.status).toBe(201)
    })

    test("an entry is found by a word only its keys hold", async () => {
      const memory = project("keys")
      const term = word()
      const entry = (await memory.fact("The meter table.", { keys: `meters ${term}` })).body.entry
      await memory.fact("Another entry.")
      expect((await memory.search({ query: term, scopes: "all" })).body.entries).toEqual([scored(entry)])
    })

    test("the same text with other keys is an exact copy and the first entry's keys stay", async () => {
      const memory = project("keys")
      const first = (await memory.fact("Same text, other keys.", { keys: "first keys" })).body.entry
      const again = await memory.fact("Same text, other keys.", { keys: "second keys" })
      expect(again.status).toBe(200)
      expect(JSON.parse(again.text)).toEqual({ entry: first, existing: true })
      expect((await memory.read(first.id)).body.entry.keys).toBe("first keys")
    })

    test("a replacement's keys are its own", async () => {
      const memory = project("keys")
      const term = word()
      const one = (await memory.fact("Version one.", { keys: `old ${term}` })).body.entry
      const two = await memory.fact("Version two.", { supersedes: one.id })
      expect(two.body.entry.keys).toBe("")
      const three = await memory.fact("Version three.", { supersedes: two.body.entry.id, keys: "new keys" })
      expect(three.body.entry.keys).toBe("new keys")
      expect((await memory.read(one.id)).body.entry.keys).toBe(`old ${term}`)
      expect((await memory.search({ query: term, scopes: "all" })).body.entries).toEqual([])
    })

    test("after forget keys are null and a word of the old keys finds nothing", async () => {
      const memory = project("keys")
      const term = word()
      const entry = (await memory.fact("Forget my keys.", { keys: `secret ${term}` })).body.entry
      expect((await memory.forget(entry.id)).body.entry.keys).toBeNull()
      expect((await memory.read(entry.id)).body.entry.keys).toBeNull()
      expect((await memory.search({ query: term, scopes: "all" })).body.entries).toEqual([])
    })

    test("the export has keys, null for a deleted entry", async () => {
      const memory = project("keys")
      const kept = (await memory.fact("Kept.", { keys: "kept keys" })).body.entry
      const gone = (await memory.fact("Gone.", { keys: "gone keys" })).body.entry
      await memory.forget(gone.id)
      expect((await memory.export()).lines.map((line) => [line.id, line.keys])).toEqual([
        [kept.id, "kept keys"],
        [gone.id, null],
      ])
    })
  })

  describe("score", () => {
    test("every entry of search and start has a score above 0", async () => {
      const memory = project("score")
      const term = word()
      for (const index of Array.from({ length: 4 }, (_, index) => index))
        await memory.fact(`Scored ${index} ${term}${" twice".repeat(index)}.`)
      const search = await memory.search({ query: `${term} twice`, scopes: "all" })
      const start = await memory.start({ prompt: `${term} twice`, scopes: "all" })
      expect(search.body.entries.length).toBe(4)
      expect(start.body.entries.length).toBe(4)
      ;[...search.body.entries, ...start.body.entries].forEach((entry) => expect(entry.score).toBeGreaterThan(0))
    })

    test("a written, read, forgotten and exported entry has no score", async () => {
      const memory = project("score")
      const written = (await memory.fact("No score here.")).body.entry
      const read = (await memory.read(written.id)).body.entry
      const forgotten = (await memory.forget(written.id)).body.entry
      const exported = (await memory.export()).lines[0]
      ;[written, read, forgotten, exported].forEach((entry) => expect(entry).not.toHaveProperty("score"))
    })
  })

  test("export: one line per entry in the order stored, replaced entries in full, deleted ones without text", async () => {
    const memory = project("export")
    const one = (await memory.fact("Export one.")).body.entry
    const two = (await memory.fact("Export two.", { scope: "role" })).body.entry
    const three = (await memory.fact("Export three.", { supersedes: one.id })).body.entry
    await memory.forget(two.id)
    const answer = await memory.export()
    expect(answer.status).toBe(200)
    expect(answer.type).toStartWith("application/x-ndjson")
    expect(answer.lines.map((line) => line.type)).toEqual(["entry", "entry", "entry"])
    expect(answer.lines.map((line) => line.id)).toEqual([one.id, two.id, three.id])
    expect(answer.lines[0]).toEqual({ type: "entry", ...one, superseded_by: three.id })
    expect(answer.lines[1]).toEqual({ type: "entry", ...(await memory.read(two.id)).body.entry })
    expect(answer.lines[1]).toMatchObject({ text: null, basis: null, keys: null })
    expect(answer.lines[2]).toEqual({ type: "entry", ...three })
  })

  describe("concurrent writers", () => {
    test("20 writes of different texts at once make 20 entries", async () => {
      const memory = project("writers")
      const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => memory.fact(`Writer ${index}.`)))
      expect(answers.map((answer) => answer.status)).toEqual(Array.from({ length: 20 }, () => 201))
      expect(new Set(answers.map((answer) => answer.body.entry.id)).size).toBe(20)
      expect((await memory.export()).lines.length).toBe(20)
    })

    test("20 writes of the same text at once make one entry", async () => {
      const memory = project("writers")
      const answers = await Promise.all(Array.from({ length: 20 }, () => memory.fact("The same writer.")))
      expect(answers.filter((answer) => answer.status === 201).length).toBe(1)
      expect(answers.filter((answer) => answer.status === 200 && answer.body.existing === true).length).toBe(19)
      expect(new Set(answers.map((answer) => answer.body.entry.id)).size).toBe(1)
      expect((await memory.export()).lines.length).toBe(1)
    })
  })

  test("capabilities say that the server has memory, with its limits", async () => {
    const answer = await send("GET", "/pacer/v1/capabilities")
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      pacer: {
        memory: { version: 1, entry_characters: 800, keys_characters: 600, query_characters: 2000, search_limit: 20 },
      },
    })
  })

  test("an unknown route under /pacer/v1/memory/ is 404 not_found", async () => {
    expectNotFound(await send("GET", `/pacer/v1/memory/${project("routes").id}/nothing`))
    expectNotFound(await send("POST", `/pacer/v1/memory/${project("routes").id}/entries/000000000000/nothing`, {}))
  })
}
