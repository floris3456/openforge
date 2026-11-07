import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { toolInlineInfo, toolScroll } from "../../src/mini/tool"
import { permissionInfo } from "../../src/mini/permission.shared"
import { partPath } from "../../src/routes/session/grouping/session"
import { toolDisplay } from "../../src/routes/session/message-parts"
import { permissionPresentation } from "../../src/util/permission"
import { canonicalToolPart } from "../mini/fixture/tool-part"

// Section 4 of spec cliproxypacer-step-2 where it isn't the chat's rows: `opencode run`'s lines, the permission a call
// asks, and how the transcript sorts the calls. The rows themselves are drawn in web-tools.test.tsx.

const JOB = "job_0123456789abcdef0123456789abcdef"

function done(name: string, input: Record<string, string | string[] | boolean>, provider?: string) {
  return canonicalToolPart(name, {
    status: "completed",
    input,
    metadata: provider ? { provider } : {},
    content: [{ type: "text", text: "CPP's text" }],
  })
}

function frame(part: SessionMessageAssistantTool) {
  if (part.state.status === "streaming") throw new Error("a call with its input")
  return {
    name: part.name,
    input: part.state.input,
    meta: part.state.metadata ?? {},
    state: {},
    status: part.state.status,
    error: "",
    output: "",
    raw: "",
    time: {},
  }
}

describe("opencode run's lines", () => {
  const cases: [SessionMessageAssistantTool, string][] = [
    [done("web_search", { query: "rust 1.95" }, "ChatGPT"), '◈ Web Search via ChatGPT "rust 1.95"'],
    [done("web_search", { query: "rust 1.95" }), '◈ Web Search "rust 1.95"'],
    [done("web_research", { question: "Who ships it?" }, "Exa"), '◈ Web Research via Exa "Who ships it?"'],
    [
      done("web_extract", { urls: ["https://a.example/", "https://b.example/"] }, "Exa"),
      "% Web Extract via Exa https://a.example/ (+1 more)",
    ],
    [
      done("web_crawl", { url: "https://a.example/docs" }, "Firecrawl"),
      "% Web Crawl via Firecrawl https://a.example/docs",
    ],
    [done("web_research", { job_id: JOB }, "You.com"), `◈ Web Research via You.com job ${JOB}`],
    [done("web_crawl", { job_id: JOB, cancel: true }), `% Web Crawl cancel job ${JOB}`],
  ]

  test.each(cases)("%#: the inline line and the scrollback's are the chat's row", (part, line) => {
    const inline = toolInlineInfo(part)
    expect(`${inline.icon} ${inline.title}`).toBe(line)
    expect(toolScroll("start", frame(part))).toBe(line)
  })

  test("a failed call's last line is CPP's text, as any tool's", () => {
    const part = canonicalToolPart("web_search", {
      status: "error",
      input: { query: "rust 1.95" },
      metadata: { error: "unavailable" },
      error: { type: "tool.execution", message: "Web search: unavailable. Go on without it." },
    })
    expect(toolScroll("final", { ...frame(part), error: "Web search: unavailable. Go on without it." })).toBe(
      "✖ web_search failed: Web search: unavailable. Go on without it.",
    )
  })
})

describe("the permission a call asks", () => {
  const ask = (action: string, tool: string, input: Record<string, unknown>, resources: string[]) =>
    permissionPresentation({ action, resources, input, tool })

  test("search and research ask as websearch, with what they look for", () => {
    expect(ask("websearch", "web_search", { query: "rust 1.95" }, ["rust 1.95"])).toEqual({
      icon: "◈",
      title: 'Web Search "rust 1.95"',
      lines: ["Query: rust 1.95"],
    })
    expect(ask("websearch", "web_research", { question: "Who ships it?" }, ["Who ships it?"])).toEqual({
      icon: "◈",
      title: 'Web Research "Who ships it?"',
      lines: ["Question: Who ships it?"],
    })
  })

  test("extract and crawl ask as webfetch, with every URL", () => {
    expect(ask("webfetch", "web_extract", { urls: ["https://a.example/", "https://b.example/"] }, [])).toEqual({
      icon: "%",
      title: "Web Extract https://a.example/ (+1 more)",
      lines: ["URL: https://a.example/", "URL: https://b.example/"],
    })
    expect(ask("webfetch", "web_crawl", { url: "https://a.example/docs" }, [])).toEqual({
      icon: "%",
      title: "Web Crawl https://a.example/docs",
      lines: ["URL: https://a.example/docs"],
    })
  })

  test("a job's next call asks with its id", () => {
    expect(ask("websearch", "web_research", { job_id: JOB }, [JOB])).toEqual({
      icon: "◈",
      title: `Web Research job ${JOB}`,
      lines: [`Job: ${JOB}`],
    })
    expect(ask("webfetch", "web_crawl", { job_id: JOB, cancel: true }, [JOB])).toEqual({
      icon: "%",
      title: `Web Crawl cancel job ${JOB}`,
      lines: [`Job: ${JOB} (cancel)`],
    })
  })

  test("upstream's own websearch and webfetch ask as before", () => {
    expect(ask("websearch", "websearch", { query: "rust" }, ["rust"])).toEqual({
      icon: "◈",
      title: 'Web Search "rust"',
      lines: ["Query: rust"],
    })
    expect(ask("webfetch", "webfetch", { url: "https://a.example/" }, ["https://a.example/"])).toEqual({
      icon: "%",
      title: "WebFetch https://a.example/",
      lines: ["URL: https://a.example/"],
    })
  })

  test("opencode run's prompt names the tool as the chat's does", () => {
    const tool = canonicalToolPart("web_research", {
      status: "running",
      input: { question: "Who ships it?" },
      metadata: {},
    })
    expect(
      permissionInfo({ id: "per_web", sessionID: "ses_web", action: "websearch", resources: ["Who ships it?"], tool }),
    ).toMatchObject({ title: 'Web Research "Who ships it?"', lines: ["Question: Who ships it?"] })
  })
})

describe("in the transcript", () => {
  test("the four tools have their own rows, grouped as explorations as upstream's search and fetch", () => {
    for (const name of ["web_search", "web_research", "web_extract", "web_crawl", "websearch", "webfetch"]) {
      expect(partPath({ type: "tool", name }, "medium")).toEqual(["exploration"])
      expect(toolDisplay(name)).toBe(name)
    }
    expect(partPath({ type: "tool", name: "web_search" }, "low")).toEqual(["activity", "exploration"])
  })
})
