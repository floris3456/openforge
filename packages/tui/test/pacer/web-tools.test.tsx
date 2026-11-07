import { describe, expect, test } from "bun:test"
import type {
  JsonValue,
  OpenCodeEvent,
  PermissionRequest,
  SessionInfo,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import type { CapturedLine } from "@opentui/core"
import { createAppFixture } from "../fixture/app"
import { recordFrames, type RecordedFrame } from "../fixture/frames"
import { directory, json } from "../fixture/tui-client"
import { until } from "../fixture/wait"

// Section 4 of spec cliproxypacer-step-2: CPP's web tool calls in the chat, as upstream's search and fetch rows and
// grouped with them, the service's name once CPP's answer gives it. The whole app draws a chat whose messages hold
// the calls, as the service stores them; events move them on as a call runs. Every frame the renderer draws is
// recorded and checked, not only the last.

const SESSION = "ses_web_tools"
const session = {
  id: SESSION,
  title: "Web tools",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
} satisfies SessionInfo
const model = { providerID: "fixture", id: "fixture" }
const STEP = "msg_step"
const QUERY = "rust 1.95 release notes"
const QUESTION = "Which Linux distributions ship Rust 1.95 in their stable repositories?"
const URLS = ["https://blog.rust-lang.org/2026/10/30/Rust-1.95.0/", "https://doc.rust-lang.org/", "https://crates.io/"]
const SITE = "https://doc.rust-lang.org/stable/releases.html"
const JOB = "job_0123456789abcdef0123456789abcdef"

type State = SessionMessageAssistantTool["state"]
type Input = Record<string, JsonValue>

const running = (input: Input): State => ({ status: "running", input, metadata: {} })
const completed = (input: Input, metadata: Record<string, string | Record<string, string>> = {}): State => ({
  status: "completed",
  input,
  metadata,
  content: [{ type: "text", text: "CPP's text" }],
})
const failed = (input: Input, message: string, metadata: Record<string, string> = {}): State => ({
  status: "error",
  input,
  metadata,
  error: { type: "tool.execution", message },
})

function call(id: string, name: string, state: State): SessionMessageAssistantTool {
  return {
    type: "tool",
    id,
    name,
    time: { created: 10, ...(state.status === "running" ? {} : { completed: 11 }) },
    state,
  }
}

/** A chat of one prompt and one step whose tools are `parts`; the step still runs unless `done`. */
function chat(parts: SessionMessageAssistantTool[], done = true): SessionMessageInfo[] {
  return [
    { type: "user", id: "msg_user", text: "Find the release notes", time: { created: 1 } },
    {
      type: "assistant",
      id: STEP,
      agent: "build",
      model,
      time: { created: 2, ...(done ? { completed: 20 } : {}) },
      ...(done ? { finish: "stop" as const } : {}),
      content: parts,
    },
  ]
}

/**
 * The app on the chat. Its messages are answered once the recorder listens, so `recorder` holds every frame from
 * before they are drawn.
 */
async function transcript(
  messages: SessionMessageInfo[],
  input: { width?: number; height?: number; grouping?: "auto" | "none"; permissions?: PermissionRequest[] } = {},
) {
  const listening = Promise.withResolvers<void>()
  const setup = await createAppFixture({
    width: input.width ?? 120,
    height: input.height ?? 30,
    args: { sessionID: SESSION },
    config: { animations: false, session: { sidebar: "hide", grouping: input.grouping ?? "none" } },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${SESSION}`) return json({ data: session })
      if (url.pathname === `/api/session/${SESSION}/message`)
        return listening.promise.then(() => json({ data: messages.toReversed(), cursor: {} }))
      if (url.pathname === `/api/session/${SESSION}/permission`) return json({ data: input.permissions ?? [] })
      if (url.pathname === `/api/session/${SESSION}/inbox`) return json({ data: [] })
    },
  })
  await setup.ready
  const recorder = recordFrames(setup)
  listening.resolve()
  return {
    ...setup,
    recorder,
    emit: (event: OpenCodeEvent) => setup.events.emit(event),
    /** Resolves with the first frame, as text, that matches; fails with the last one after 5 s. */
    async frame(match: (frame: string) => boolean) {
      await until(() => match(setup.captureCharFrame()), 5_000).catch(() => {
        throw new Error(`no frame matched within 5 s:\n${setup.captureCharFrame()}`)
      })
      return setup.captureCharFrame()
    },
    async [Symbol.asyncDispose]() {
      recorder.stop()
      await setup[Symbol.asyncDispose]()
    },
  }
}

type Setup = Awaited<ReturnType<typeof transcript>>

let seq = 10
function durable<const Version extends 1 | 2 = 1>(version?: Version) {
  return { aggregateID: SESSION, seq: seq++, version: (version ?? 1) as Version }
}

/** The events of one call: its input streams, it runs, and it ends with CPP's answer or fails with CPP's text. */
const events = {
  started: (id: string, name: string) => ({
    id: `evt_${id}_started`,
    created: 12,
    type: "session.tool.input.started" as const,
    durable: durable(),
    location: { directory },
    data: { sessionID: SESSION, assistantMessageID: STEP, id, name },
  }),
  called: (id: string, input: Input) => ({
    id: `evt_${id}_called`,
    created: 13,
    type: "session.tool.called" as const,
    durable: durable(),
    location: { directory },
    data: { sessionID: SESSION, assistantMessageID: STEP, id, input, executed: true },
  }),
  success: (id: string, metadata: Record<string, string | Record<string, string>>) => ({
    id: `evt_${id}_success`,
    created: 14,
    type: "session.tool.success" as const,
    durable: durable(2),
    location: { directory },
    data: {
      sessionID: SESSION,
      assistantMessageID: STEP,
      id,
      content: [{ type: "text" as const, text: "CPP's text" }] as [{ type: "text"; text: string }],
      metadata,
      executed: true,
    },
  }),
  failed: (id: string, message: string, metadata: Record<string, string>) => ({
    id: `evt_${id}_failed`,
    created: 14,
    type: "session.tool.failed" as const,
    durable: durable(2),
    location: { directory },
    data: {
      sessionID: SESSION,
      assistantMessageID: STEP,
      id,
      error: { type: "tool.execution" as const, message },
      metadata,
      executed: true,
    },
  }),
}

const lines = (frame: string) => frame.split("\n").map((line) => line.trim())
/** The frame's lines that start with one of the tools' icons: the rows. */
const rows = (frame: string) => lines(frame).filter((line) => /^[◈%✱→] /.test(line))

/** Every recorded frame since `start` that shows `row` shows it as one of `states`, in their order, never back. */
function inOrder(
  frames: readonly RecordedFrame[],
  states: readonly string[],
  row: (frame: string) => string | undefined,
) {
  const seen = frames.flatMap((frame) => {
    const line = row(frame.text)
    return line === undefined ? [] : [line]
  })
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.filter((line) => !states.includes(line))).toEqual([])
  const order = seen.map((line) => states.indexOf(line))
  expect(order).toEqual(order.toSorted((a, b) => a - b))
  expect(seen.at(-1)).toBe(states.at(-1)!)
}

/** The colour of a frame's row: its icon's and its text's. */
function colours(line: CapturedLine) {
  const spans = line.spans.filter((span) => span.text.trim())
  return { icon: spans[0]?.fg.toInts(), text: spans[1]?.fg.toInts() }
}

function rowLine(setup: Setup, start: string) {
  return setup.captureSpans().lines.find((line) =>
    line.spans
      .map((span) => span.text)
      .join("")
      .trim()
      .startsWith(start),
  )
}

describe("the rows", () => {
  const all = [
    call("call_search", "web_search", completed({ query: QUERY, max_results: 5 }, { provider: "ChatGPT" })),
    call("call_research", "web_research", completed({ question: QUESTION }, { provider: "Exa" })),
    call("call_extract", "web_extract", completed({ urls: URLS }, { provider: "Firecrawl" })),
    call("call_extract_one", "web_extract", completed({ urls: [URLS[0]] }, { provider: "You.com" })),
    call("call_crawl", "web_crawl", completed({ url: SITE, limit: 20 }, { provider: "Firecrawl" })),
    call("call_job", "web_research", completed({ job_id: JOB }, { provider: "You.com" })),
    call("call_cancel", "web_crawl", completed({ job_id: JOB, cancel: true })),
  ]
  const expected = [
    `◈ Web Search via ChatGPT "${QUERY}"`,
    `◈ Web Research via Exa "${QUESTION}"`,
    `% Web Extract via Firecrawl ${URLS[0]} (+2 more)`,
    `% Web Extract via You.com ${URLS[0]}`,
    `% Web Crawl via Firecrawl ${SITE}`,
    `◈ Web Research via You.com job ${JOB}`,
    `% Web Crawl cancel job ${JOB}`,
  ]

  test("each finished call shows its row as the spec writes it, on every frame", async () => {
    await using setup = await transcript(chat(all))
    await setup.frame((frame) => rows(frame).length === expected.length)
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(rows(setup.captureCharFrame())).toEqual(expected)
    // The rows come with the messages, all at once and whole: no frame shows a part of one or a row without its name.
    expect(setup.recorder.missed).toBe(0)
    const drawn = setup.recorder.frames.filter((frame) => rows(frame.text).length > 0).map((frame) => rows(frame.text))
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.filter((shown) => shown.join("\n") !== expected.join("\n"))).toEqual([])
  })

  test("in a narrow window a long row wraps, its words whole and in order", async () => {
    await using setup = await transcript(chat(all.slice(0, 3)), { width: 44 })
    const words = (frame: string) => frame.replace(/[┃│]/g, " ").replace(/\s+/g, " ")
    await setup.frame((frame) => words(frame).includes(`(+2 more)`))
    const frame = words(setup.captureCharFrame())
    expect(frame).toContain(`◈ Web Search via ChatGPT "${QUERY}"`)
    expect(frame).toContain(`◈ Web Research via Exa "${QUESTION}"`)
    // A URL longer than the line breaks inside it; the row still ends with how many more.
    expect(frame.replace(/ /g, "")).toContain(`%WebExtractviaFirecrawl${URLS[0]}(+2more)`)
  })

  test("they are drawn as upstream's search and fetch rows, finished and failed alike", async () => {
    await using setup = await transcript(
      chat([
        call("call_upstream", "websearch", completed({ query: "upstream" }, { provider: "exa" })),
        call("call_search", "web_search", completed({ query: QUERY }, { provider: "ChatGPT" })),
        call("call_fetch", "webfetch", completed({ url: SITE })),
        call("call_crawl", "web_crawl", completed({ url: SITE }, { provider: "Tavily" })),
        call("call_upstream_failed", "websearch", failed({ query: "upstream failed" }, "Web search request failed")),
        call("call_failed", "web_search", failed({ query: "failed" }, "Web search: unavailable.")),
      ]),
    )
    await setup.frame((frame) => rows(frame).length === 6)
    expect(rows(setup.captureCharFrame())).toEqual([
      `◈ Web Search via Exa "upstream"`,
      `◈ Web Search via ChatGPT "${QUERY}"`,
      `% WebFetch ${SITE}`,
      `% Web Crawl via Tavily ${SITE}`,
      `◈ Web Search "upstream failed"`,
      `◈ Web Search "failed"`,
    ])
    const style = (start: string) => colours(rowLine(setup, start)!)
    expect(style(`◈ Web Search via ChatGPT`)).toEqual(style(`◈ Web Search via Exa`))
    expect(style(`% Web Crawl`)).toEqual(style(`% WebFetch`))
    expect(style(`◈ Web Search "failed"`)).toEqual(style(`◈ Web Search "upstream failed"`))
    expect(style(`◈ Web Search "failed"`)).not.toEqual(style(`◈ Web Search via ChatGPT`))
  })
})

describe("a call as it runs", () => {
  const cases: { name: string; input: Input; states: string[]; provider: string }[] = [
    {
      name: "web_search",
      input: { query: QUERY },
      states: ["Searching web…", `◈ Web Search "${QUERY}"`, `◈ Web Search via ChatGPT "${QUERY}"`],
      provider: "ChatGPT",
    },
    {
      name: "web_research",
      input: { question: QUESTION },
      states: ["Researching the web…", `◈ Web Research "${QUESTION}"`, `◈ Web Research via Exa "${QUESTION}"`],
      provider: "Exa",
    },
    {
      name: "web_extract",
      input: { urls: URLS },
      states: [
        "Fetching from the web…",
        `% Web Extract ${URLS[0]} (+2 more)`,
        `% Web Extract via Firecrawl ${URLS[0]} (+2 more)`,
      ],
      provider: "Firecrawl",
    },
    {
      name: "web_crawl",
      input: { url: SITE },
      states: ["Crawling the web…", `% Web Crawl ${SITE}`, `% Web Crawl via Tavily ${SITE}`],
      provider: "Tavily",
    },
  ]
  test.each(cases)(
    "$name: the row while its input streams, while it runs, and once CPP answers, on every frame",
    async (item) => {
      await using setup = await transcript(chat([], false), { width: 160 })
      await setup.frame((frame) => frame.includes("Find the release notes"))
      const since = setup.recorder.mark()
      const row = (frame: string) =>
        lines(frame).find((line) => item.states.some((state) => line.includes(state.replace(/^[◈%] /, ""))))
      setup.emit(events.started("call_web", item.name))
      await setup.frame((frame) => row(frame)?.includes(item.states[0]!) === true)
      setup.emit(events.called("call_web", item.input))
      await setup.frame((frame) => row(frame) === item.states[1])
      setup.emit(events.success("call_web", { provider: item.provider }))
      await setup.frame((frame) => row(frame) === item.states.at(-1))
      await setup.waitForVisualIdle({ quietFrames: 3 })
      expect(setup.recorder.missed).toBe(0)
      // While the input streams the row is upstream's spinner with the pending words; the spinner's glyph changes.
      inOrder(since(), item.states, (frame) => {
        const line = row(frame)
        return line === undefined ? undefined : (item.states.find((state) => line.endsWith(state)) ?? line)
      })
    },
  )

  test("a search that fails shows CPP's text only when clicked, its row unchanged, on every frame", async () => {
    const text = "Web search: unavailable (no provider could serve this call). Go on without it."
    await using setup = await transcript(chat([call("call_web", "web_search", running({ query: QUERY }))], false))
    const shown = `◈ Web Search "${QUERY}"`
    await setup.frame((frame) => rows(frame).includes(shown))
    const before = JSON.stringify(colours(rowLine(setup, shown)!))
    const since = setup.recorder.mark()
    setup.emit(events.failed("call_web", text, { error: "unavailable" }))
    await setup.frame(() => {
      const line = rowLine(setup, shown)
      return line !== undefined && JSON.stringify(colours(line)) !== before
    })
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(setup.recorder.missed).toBe(0)
    expect(since().length).toBeGreaterThan(0)
    expect(since().filter((frame) => !rows(frame.text).includes(shown))).toEqual([])
    expect(since().filter((frame) => frame.text.includes("Go on without it"))).toEqual([])
    const row = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes(shown))
    await setup.mockMouse.click(6, row)
    const frame = await setup.frame((frame) => frame.includes("Go on without it"))
    expect(frame.replace(/\s+/g, " ")).toContain(text)
  })

  test("a job: the first call ends with the job, the next one is the same row with its id", async () => {
    await using setup = await transcript(
      chat([call("call_first", "web_crawl", completed({ url: SITE }, { job: { id: JOB, status: "running" } }))], false),
    )
    await setup.frame((frame) => rows(frame).includes(`% Web Crawl ${SITE}`))
    const since = setup.recorder.mark()
    setup.emit(events.started("call_next", "web_crawl"))
    setup.emit(events.called("call_next", { job_id: JOB }))
    await setup.frame((frame) => rows(frame).includes(`% Web Crawl job ${JOB}`))
    setup.emit(events.success("call_next", { provider: "Firecrawl" }))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(rows(setup.captureCharFrame())).toEqual([`% Web Crawl ${SITE}`, `% Web Crawl via Firecrawl job ${JOB}`])
    expect(setup.recorder.missed).toBe(0)
    // The first row stays as it was on every frame; the next call's row is its pending words, then the job, for good.
    expect(since().filter((frame) => rows(frame.text)[0] !== `% Web Crawl ${SITE}`)).toEqual([])
    const states = ["Crawling the web…", `% Web Crawl job ${JOB}`, `% Web Crawl via Firecrawl job ${JOB}`]
    inOrder(since(), states, (frame) => {
      const line = lines(frame).find((line) => line.endsWith(states[0]!) || line.includes(`job ${JOB}`))
      return line?.endsWith(states[0]!) ? states[0] : line
    })
  })
})

describe("grouped with upstream's search and fetch", () => {
  const parts = [
    call("call_upstream_search", "websearch", completed({ query: "upstream" }, { provider: "exa" })),
    call("call_search", "web_search", completed({ query: QUERY }, { provider: "ChatGPT" })),
    call("call_upstream_fetch", "webfetch", completed({ url: SITE })),
    call("call_extract", "web_extract", completed({ urls: URLS }, { provider: "Firecrawl" })),
    call("call_research", "web_research", completed({ question: QUESTION }, { provider: "Exa" })),
    call("call_crawl", "web_crawl", completed({ url: SITE }, { provider: "Tavily" })),
  ]

  test("searches and research count as searches, extracts and crawls as fetches; expanded, the rows in order", async () => {
    await using setup = await transcript(chat(parts), { grouping: "auto" })
    const frame = await setup.frame((frame) => frame.includes("Explored:"))
    expect(lines(frame).filter((line) => line.includes("Explored:"))).toEqual(["→ Explored: 3 searches, 3 fetches"])
    expect(rows(frame).filter((line) => line.startsWith("◈") || line.startsWith("%"))).toEqual([])
    const row = frame.split("\n").findIndex((line) => line.includes("Explored:"))
    await setup.mockMouse.click(6, row)
    const expanded = await setup.frame((frame) => rows(frame).length === 7)
    expect(rows(expanded)).toEqual([
      "→ Explored: 3 searches, 3 fetches",
      `◈ Web Search via Exa "upstream"`,
      `◈ Web Search via ChatGPT "${QUERY}"`,
      `% WebFetch ${SITE}`,
      `% Web Extract via Firecrawl ${URLS[0]} (+2 more)`,
      `◈ Web Research via Exa "${QUESTION}"`,
      `% Web Crawl via Tavily ${SITE}`,
    ])
  })

  test("a call that runs joins the group, which counts it once it ends, on every frame", async () => {
    await using setup = await transcript(chat(parts.slice(0, 2), false), { grouping: "auto" })
    await setup.frame((frame) => frame.includes("2 searches"))
    const since = setup.recorder.mark()
    setup.emit(events.started("call_more", "web_extract"))
    setup.emit(events.called("call_more", { urls: URLS }))
    await setup.frame((frame) => frame.includes("2 searches, 1 fetch"))
    setup.emit(events.success("call_more", { provider: "Exa" }))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(setup.recorder.missed).toBe(0)
    const labels = since().map((frame) => lines(frame.text).find((line) => /Explor(ed|ing):/.test(line)))
    // One group throughout, never split or emptied; it counts the extract from the frame its input arrives.
    expect(labels.filter((label) => label === undefined)).toEqual([])
    expect(
      labels.filter((label) => !/^. Explor(ed|ing): 2 searches(, 1 fetch)?$/.test(label!.replace(/^\S+ /, "x "))),
    ).toEqual([])
  })
})

test("the permission a call asks names what it searches for", async () => {
  const request: PermissionRequest = {
    id: "per_web",
    sessionID: SESSION,
    action: "websearch",
    resources: [QUESTION],
    source: { type: "tool", messageID: STEP, id: "call_web" },
  }
  await using setup = await transcript(
    chat([call("call_web", "web_research", running({ question: QUESTION }))], false),
    { permissions: [request] },
  )
  const frame = await setup.frame((frame) => frame.includes("Question:"))
  const flat = frame.replace(/[┃│]/g, " ").replace(/\s+/g, " ")
  expect(flat).toContain(`Web Research "${QUESTION}"`)
  expect(flat).toContain(`Question: ${QUESTION}`)
})
