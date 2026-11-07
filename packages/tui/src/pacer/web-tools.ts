import { isRecord } from "../util/record"
import { webSearchProviderName } from "../util/tool-display"

// CLIProxyPacer's web tools in the chat (spec cliproxypacer-step-2, section 4). A call shows as upstream's search and
// fetch rows do and is grouped with them: search and research as searches, extract and crawl as fetches. The row is
// made of the call's input, CPP's arguments as the model wrote them, and its metadata: `provider`, the service's name
// from CPP's answer, which a running call doesn't have yet; each of the four names it, as CPP may have chosen a paid
// one. A job's next call names no subject, only its `job_id`; a call whose answer says its job still runs ends its row
// with `· job running`.

const tools = {
  web_search: { kind: "search", icon: "◈", label: "Web Search", subject: "query", pending: "Searching web…" },
  web_research: {
    kind: "search",
    icon: "◈",
    label: "Web Research",
    subject: "question",
    pending: "Researching the web…",
  },
  web_extract: { kind: "fetch", icon: "%", label: "Web Extract", subject: "urls", pending: "Fetching from the web…" },
  web_crawl: { kind: "fetch", icon: "%", label: "Web Crawl", subject: "url", pending: "Crawling the web…" },
} as const

export type WebToolName = keyof typeof tools
export type WebTool = (typeof tools)[WebToolName]

/** The four tools' names. */
export const WEB_TOOLS = Object.keys(tools) as WebToolName[]

/** The tool, when `name` is one of CPP's web tools. */
export function webTool(name: string): WebTool | undefined {
  return Object.hasOwn(tools, name) ? tools[name as WebToolName] : undefined
}

/**
 * What the row names after its label: the query or question in quotes, the URL (the first of several, with how many
 * more), or a job's id for its next call. Undefined while the input has none, as while it streams.
 */
export function webToolSubject(name: string, input: Record<string, unknown>) {
  const tool = webTool(name)
  if (!tool) return undefined
  if (typeof input.job_id === "string" && input.job_id)
    return input.cancel === true ? `cancel job ${input.job_id}` : `job ${input.job_id}`
  if (tool.subject === "urls") {
    const urls = Array.isArray(input.urls) ? input.urls.filter((url): url is string => typeof url === "string") : []
    if (urls.length === 0) return undefined
    return urls.length === 1 ? urls[0] : `${urls[0]} (+${urls.length - 1} more)`
  }
  const value = input[tool.subject]
  if (typeof value !== "string" || !value) return undefined
  return tool.kind === "search" ? `"${value}"` : value
}

/** The service the call names, once CPP's answer gave it. */
export function webToolProvider(name: string, metadata: Record<string, unknown>) {
  if (!webTool(name)) return ""
  return webSearchProviderName(metadata.provider)
}

/** Whether CPP's answer says the call's job still runs: its `job.status` is `starting` or `running`. */
export function webToolJobRunning(metadata: Record<string, unknown>) {
  return isRecord(metadata.job) && (metadata.job.status === "starting" || metadata.job.status === "running")
}

/** The row as one line, without its icon: `Web Search via ChatGPT "rust 1.95 release notes"`. */
export function webToolTitle(name: string, input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const tool = webTool(name)
  if (!tool) return name
  const provider = webToolProvider(name, metadata)
  const subject = webToolSubject(name, input)
  const words = [tool.label, ...(provider ? ["via", provider] : []), ...(subject ? [subject] : [])].join(" ")
  return webToolJobRunning(metadata) ? `${words} · job running` : words
}

/** The permission a call asks before it goes: what it searches for or reads, before any service is chosen. */
export function webToolPermission(name: string, input: Record<string, unknown>) {
  const tool = webTool(name)
  if (!tool) return undefined
  const subject = webToolSubject(name, input)
  const job = typeof input.job_id === "string" && input.job_id ? input.job_id : undefined
  const lines = (() => {
    if (job) return [`Job: ${job}${input.cancel === true ? " (cancel)" : ""}`]
    if (tool.subject === "urls")
      return (Array.isArray(input.urls) ? input.urls : []).flatMap((url) =>
        typeof url === "string" ? [`URL: ${url}`] : [],
      )
    const value = input[tool.subject]
    if (typeof value !== "string" || !value) return []
    return [`${tool.subject === "query" ? "Query" : tool.subject === "question" ? "Question" : "URL"}: ${value}`]
  })()
  return { icon: tool.icon, title: subject ? `${tool.label} ${subject}` : tool.label, lines }
}
