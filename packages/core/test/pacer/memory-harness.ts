import memoryTools from "./fixtures/memory-tools.json"

/**
 * CLIProxyPacer's harness side of memory as far as openforge's tests need it (the workspace's reference
 * `docs/reference/cpp-tools-api.md`), over the small memory server's store: the memory tools in each chat's tool list
 * and their calls, the start block's and a prompt's texts, the task check, a subagent's task, and memory's texts. Who
 * asks comes from the headers, and the chat's place is kept here per key and chat. Its texts are this file's own,
 * short and plain: CPP's words are CPP's to test.
 */

type Fields = Record<string, unknown>
export type Place = { readonly task: string; readonly subtask: string | null } | null

/** The memory tools' definitions as openforge 0.0.42 sent them, which CPP's list holds byte for byte. */
export const definitions = memoryTools
const meta: Record<string, { title: string; permission: string; subject: string[]; read_only: boolean }> = {
  remember: { title: "Remember", permission: "remember", subject: [], read_only: false },
  recall: { title: "Recall", permission: "recall", subject: [], read_only: true },
  forget: { title: "Forget", permission: "forget", subject: [], read_only: false },
  task: { title: "Task", permission: "task", subject: [], read_only: false },
}

export const texts = {
  unavailable: "Memory is unavailable right now (fake), so this chat starts without it.",
  refused: "No task (fake): nothing was changed; make or join a task first.",
}

/** The store's routes this calls, each answering a Response as the memory API does. */
export interface Store {
  readonly write: (project: string, body: Fields, person: string) => Promise<Response> | Response
  readonly forget: (project: string, id: string, body: Fields, person: string) => Response
  readonly search: (project: string, body: Fields, person: string) => Promise<Response>
  readonly start: (project: string, body: Fields, person: string) => Promise<Response>
  readonly prompt: (project: string, body: Fields, person: string) => Promise<Response>
  readonly make: (project: string, body: Fields, person: string) => Response
  readonly tasks: (project: string, all: boolean) => Response
  readonly task: (project: string, id: string) => Response
  readonly change: (project: string, id: string, body: Fields, person: string) => Response
}

/** Who asks, from the headers. */
export interface Caller {
  readonly key: string
  readonly person: string
  readonly project: string
  readonly session: string
  readonly parent?: string
  readonly role: string
  readonly chat: string
}

export function callerOf(request: Request, key: string, person: string, project: string): Caller {
  const session = request.headers.get("x-pacer-session") ?? ""
  const parent = request.headers.get("x-pacer-parent-session") ?? undefined
  return {
    key,
    person,
    project,
    session,
    ...(parent ? { parent } : {}),
    role: request.headers.get("x-pacer-agent") ?? "mcp",
    chat: request.headers.get("x-pacer-chat") ?? session,
  }
}

export function makeHarness(store: Store) {
  const places = new Map<string, Place>()
  const placeKey = (key: string, session: string) => `${key} ${session}`
  const placeOf = (who: Caller): Place => {
    const own = places.get(placeKey(who.key, who.session))
    if (own !== undefined) return own
    return who.parent ? (places.get(placeKey(who.key, who.parent)) ?? null) : null
  }
  const setPlace = (who: Caller, place: Place) => void places.set(placeKey(who.key, who.session), place)
  const by = (who: Caller) => {
    const place = placeOf(who)
    return {
      role: who.role,
      chat: who.chat,
      ...(place ? { task: place.task, ...(place.subtask ? { subtask: place.subtask } : {}) } : {}),
    }
  }
  const scopes = (who: Caller) => {
    const place = placeOf(who)
    return { global: true, roles: [who.role], ...(place ? { tasks: [place.task] } : {}) }
  }
  const json = async (response: Response | Promise<Response>) => (await response).json() as Promise<Fields>
  /** A task as reading it answers, or undefined for none: the store refuses a missing one by throwing. */
  const taskOf = async (who: Caller, id: string) => {
    const response = (() => {
      try {
        return store.task(who.project, id)
      } catch {
        return undefined
      }
    })()
    return response?.ok ? ((await response.json()) as { task: Fields; subtasks: Fields[] }) : undefined
  }
  const lineOf = (entry: Fields) => `- [${entry.id}] ${entry.text}`

  /** A tool call's answer: `{text, data, error, metadata, place}`. */
  const answer = (who: Caller, text: string, metadata: Fields = {}, error?: { code: string; message: string }) =>
    Response.json({ text, data: null, error: error ?? null, metadata, place: placeOf(who) })

  const calls: Record<string, (who: Caller, input: Fields) => Promise<Response>> = {
    remember: async (who, input) => {
      const place = placeOf(who)
      // A decision, the person's ruling, is a lead's to save and the whole project's (workspace spec
      // `docs/specs/decisions-in-memory.md`, section 1).
      const decision = input.kind === "decision"
      if (decision && who.parent) throw new Error("only a lead saves a decision")
      if (decision && (input.scope ?? "global") !== "global") throw new Error("a decision is global")
      const written = await json(
        store.write(
          who.project,
          {
            kind: input.kind,
            text: input.text,
            ...(input.basis === undefined ? {} : { basis: input.basis }),
            scope: input.scope ?? (decision ? "global" : place ? "task" : "role"),
            supersedes: input.supersedes ?? null,
            by: by(who),
          },
          who.person,
        ),
      )
      const entry = written.entry as Fields
      return answer(who, `Saved as ${entry.id}.`, { id: entry.id, near: [] })
    },
    recall: async (who, input) => {
      // Decisions alone are listed whole, 20 a page.
      const decisions = Array.isArray(input.kinds) && input.kinds.length === 1 && input.kinds[0] === "decision"
      const found = await json(
        store.search(
          who.project,
          {
            query: input.query,
            scopes: scopes(who),
            ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
            limit: input.limit ?? (decisions ? 20 : 5),
            ...(input.offset === undefined ? {} : { offset: input.offset }),
            by: by(who),
          },
          who.person,
        ),
      )
      const entries = found.entries as Fields[]
      return answer(who, ["Recalled (fake):", ...entries.map(lineOf)].join("\n"), {
        project: who.project,
        recall: found.recall,
        entries: entries.map((entry) => entry.id),
        meaning: found.meaning,
      })
    },
    forget: async (who, input) => {
      store.forget(who.project, String(input.id), { reason: input.reason, by: by(who) }, who.person)
      return answer(who, `Deleted ${input.id}.`, { id: input.id })
    },
    task: async (who, input) => {
      if (input.id === undefined && input.title === undefined) {
        const list = await json(store.tasks(who.project, false))
        return answer(who, `${(list.tasks as unknown[]).length} tasks (fake).`, {
          tasks: (list.tasks as unknown[]).length,
          more: list.more,
        })
      }
      if (input.id === undefined) {
        const made = await json(
          store.make(
            who.project,
            {
              title: input.title,
              ...(input.subtasks ? { subtasks: input.subtasks } : {}),
              by: by(who),
            },
            who.person,
          ),
        )
        const task = made.task as Fields
        const first = (made.subtasks as Fields[] | undefined)?.[0]
        if (first) setPlace(who, { task: String(task.id), subtask: String(first.id) })
        return answer(who, `Made task ${task.id} (fake).`, { id: task.id, existing: made.existing === true })
      }
      const id = String(input.id)
      const current = await taskOf(who, id)
      if (!current) return answer(who, `No task ${id} (fake).`, {}, { code: "not_found", message: "no such task" })
      if (input.state === undefined) return answer(who, `Task ${id}: ${current.task.title} (fake).`, { id })
      const place = placeOf(who)
      const next = input.state === "done" && place?.subtask === id
      const changed = await json(
        store.change(
          who.project,
          id,
          {
            state: input.state,
            ...(input.note ? { note: input.note } : {}),
            ...(next ? { next: true } : {}),
            by: by(who),
          },
          who.person,
        ),
      )
      const task = changed.task as Fields
      if (next) {
        const following = changed.next as Fields | null
        setPlace(who, { task: place!.task, subtask: following ? String(following.id) : null })
      } else if (input.state === "active")
        setPlace(who, task.parent ? { task: String(task.parent), subtask: id } : { task: id, subtask: null })
      else if (["done", "dropped", "todo"].includes(String(input.state)) && place?.task === id) setPlace(who, null)
      return answer(who, `Task ${id} is now ${task.state} (fake).`, { id, state: task.state })
    },
  }

  return {
    /** Sets the place CPP keeps for a chat, as its calls would have. */
    place: (key: string, session: string, place: Place) => void places.set(placeKey(key, session), place),
    placeOf: (key: string, session: string) => places.get(placeKey(key, session)),
    /** `GET /pacer/v1/tools`: the memory tools while the chat has memory, with their meta. */
    list: (request: Request, memory: boolean) => {
      const url = new URL(request.url)
      const listed = memory && url.searchParams.get("include") === "memory" ? definitions : []
      return Response.json({
        version: `memory-${listed.length}`,
        tools: { claude: listed, responses: [], chat: [] },
        meta: Object.fromEntries(listed.map((tool) => [tool.name, meta[tool.name]])),
      })
    },
    call: async (who: Caller, name: string, input: Fields) => {
      const run = calls[name]
      if (!run) return Response.json({ error: { type: "not_found", message: `no tool ${name}` } }, { status: 404 })
      return run(who, input).catch((error: Error) =>
        answer(who, `Refused (fake): ${error.message}`, {}, { code: "refused", message: error.message }),
      )
    },
    /** `POST …/start` with `tools`: the store's answer, with the block's text and the chat's place. */
    start: async (who: Caller, body: Fields) => {
      const place = placeOf(who)
      const started = await json(
        store.start(
          who.project,
          {
            ...body,
            tools: undefined,
            scopes: scopes(who),
            task: place?.task ?? null,
            subtask: place?.subtask ?? null,
            by: by(who),
          },
          who.person,
        ),
      )
      const tools = body.tools as { recall: boolean; remember: boolean; task: boolean }
      const text = [
        `Memory (fake) for ${who.role}:`,
        ...(started.entries as Fields[]).map(lineOf),
        `tools: recall ${tools.recall}, remember ${tools.remember}, task ${tools.task}`,
        ...(place ? [`inside ${place.task}${place.subtask ? ` on ${place.subtask}` : ""}`] : []),
      ].join("\n")
      return Response.json({ ...started, text, place })
    },
    /** `POST …/prompt` without `by`: the store's answer, with its message or null. */
    prompt: async (who: Caller, body: Fields) => {
      const prompted = await json(store.prompt(who.project, { ...body, scopes: scopes(who), by: by(who) }, who.person))
      const entries = prompted.entries as Fields[]
      return Response.json({
        ...prompted,
        text: entries.length ? ["Memory close to the prompt (fake):", ...entries.map(lineOf)].join("\n") : null,
      })
    },
    /** `GET …/chat`: the place, and the check while its subtask, else its task, is active. */
    chat: async (who: Caller) => {
      const place = placeOf(who)
      const current = place ? await taskOf(who, place.subtask ?? place.task) : undefined
      const check =
        current?.task.state === "active" ? `Task check (fake): [${current.task.id}] ${current.task.title}.` : null
      return Response.json({ place, check })
    },
    assign: async (who: Caller, id: string) => {
      const read = await taskOf(who, id)
      if (!read)
        return Response.json({ text: `No task ${id} (fake).`, error: { code: "not_found", message: "no such task" } })
      const own = read.subtasks.find(
        (sub) => sub.state === "active" && (sub.worker as Fields | null)?.chat === who.chat,
      )
      if (own)
        return Response.json({
          text: `You are on step ${own.id} of ${id} (fake): name the step.`,
          error: { code: "refused", message: "the lead's own task" },
          place: placeOf(who),
        })
      const task = read.task
      return Response.json({
        text: "",
        error: null,
        place: task.parent ? { task: task.parent, subtask: id } : { task: id, subtask: null },
      })
    },
    begin: async (who: Caller, id: string) => {
      const read = await taskOf(who, id)
      if (!read)
        return Response.json({ text: `No task ${id} (fake).`, error: { code: "not_found", message: "no such task" } })
      store.change(who.project, id, { state: "active", by: by(who) }, who.person)
      const task = read.task
      const place = task.parent ? { task: String(task.parent), subtask: id } : { task: id, subtask: null }
      setPlace(who, place)
      return Response.json({ text: "", error: null, place })
    },
    ended: async (who: Caller, id: string) => {
      const read = await taskOf(who, id)
      return Response.json({
        text: read && read.task.state !== "active" ? `Task ${id} is ${read.task.state} (fake).` : null,
      })
    },
    texts: () => Response.json(texts),
  }
}
