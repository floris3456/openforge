export * as SessionRecentText from "./recent-text.js"

import type { SessionMessage } from "./message.js"
import type { SessionStored } from "./stored.js"

const TOOL_OUTPUT_MAX_CHARS = 1_250

/**
 * The text of the messages a summary compaction kept verbatim. History rebuilds it from `metadata.keepID`;
 * compactions written before that reference carry the text they stored.
 */
export const kept = (message: SessionMessage.CompactionCompleted) =>
  typeof message.metadata?.recent === "string" ? message.metadata.recent : ""

/**
 * Set on a compaction's metadata when it is written: its recent part cuts a tool call's input as it cuts a tool's
 * output (spec checkpoint, section 4). A compaction written before keeps its recent part as it was.
 */
export const CUT_INPUTS = "recentInputs"

export const cutsInputs = (message: SessionMessage.CompactionCompleted) => message.metadata?.[CUT_INPUTS] === "cut"

/**
 * Set on a compaction's metadata when it is written between a step's tool calls and the request that would have read
 * their results: that step's message ID. The model has read nothing from there on, so the recent part shows those
 * results, and the outputs that follow them, whole while together they fit `UNREAD_CHARS`. A compaction without it
 * cuts them as before.
 */
export const UNREAD = "unreadID"

/** Set beside `UNREAD`: the characters the outputs from that step on keep together (`outputCap`). */
export const UNREAD_CHARS = "unreadChars"

/** The recent part's text from the messages it kept, cut as `compaction` records it was written to. */
export const rebuild = (
  kept: ReadonlyArray<SessionMessage.Info | SessionStored.User>,
  compaction: SessionMessage.CompactionCompleted,
): string => {
  const cut = cutsInputs(compaction)
  const unread = kept.findIndex((message) => message.id === compaction.metadata?.[UNREAD])
  const chars = compaction.metadata?.[UNREAD_CHARS]
  const cap =
    unread < 0
      ? TOOL_OUTPUT_MAX_CHARS
      : outputCap(kept.slice(unread).flatMap(outputs), typeof chars === "number" ? chars : 0)
  return kept
    .map((message, index) => messageToText(message, cut, unread < 0 || index < unread ? TOOL_OUTPUT_MAX_CHARS : cap))
    .filter(Boolean)
    .join("\n\n")
}

/**
 * One message as the recent, verbatim part of a summary shows it. Empty for messages that part leaves out. `cutInputs`
 * cuts a tool call's input to the length a tool's output is cut to by default; outputs are cut to `outputMax`.
 */
export const messageToText = (
  message: SessionMessage.Info | SessionStored.User,
  cutInputs: boolean,
  outputMax = TOOL_OUTPUT_MAX_CHARS,
): string => {
  const output = (value: string) => truncateToolOutput(value, outputMax)
  switch (message.type) {
    // Earlier summaries and instruction updates are handled outside the recent part.
    case "compaction":
    case "system":
      return ""

    case "user": {
      const skills =
        message.skills?.flatMap((skill) =>
          skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`],
        ) ?? []
      const files =
        message.files?.map((file) => {
          const name = file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")
          return `[Attached ${file.mime}: ${name}]`
        }) ?? []
      return [...skills, `[User]: ${message.text}`, ...files].join("\n")
    }

    case "location-switched":
      return `[User]: The working directory has been changed to ${message.location.directory}.`

    case "assistant":
      return message.content
        .flatMap((part) => {
          if (part.type === "text") return [`[Assistant]: ${part.text}`]
          // Providers return summaries of the real reasoning, and written out as text it can read like an attempt to
          // extract the model's thinking.
          if (part.type === "reasoning") return []

          const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
          const call = `[Assistant tool call]: ${part.name}(${cutInputs ? truncateToolOutput(input) : input})`
          if (part.state.status === "completed") {
            return [call, `[Tool result]: ${output(serializeToolContent(part.state.content))}`]
          }
          if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error.message}`]
          return [call]
        })
        .join("\n")

    case "synthetic":
      return `[Synthetic context]: ${message.text}`

    case "skill":
      return `[Skill activated: ${message.name}]\n${message.text}`

    case "shell":
      if (message.metadata?.background === true) return ""
      return `[Shell]: ${message.command}\n${output(message.output?.output ?? "")}`

    default:
      return ""
  }
}

/**
 * The most characters each of `values` keeps so that together they fit `budget`: the shorter ones whole, the longer ones
 * an equal share of what those leave, but never fewer than any other output in the recent part keeps.
 */
const outputCap = (values: ReadonlyArray<string>, budget: number) => {
  const sizes = values.map((value) => value.length).sort((a, b) => a - b)
  let left = budget
  for (const [index, size] of sizes.entries()) {
    const share = Math.floor(left / (sizes.length - index))
    if (size > share) return Math.max(TOOL_OUTPUT_MAX_CHARS, share)
    left -= size
  }
  return Number.POSITIVE_INFINITY
}

/** The tool and shell outputs `messageToText` shows of one message, before they are cut. */
const outputs = (message: SessionMessage.Info | SessionStored.User): string[] => {
  if (message.type === "assistant")
    return message.content.flatMap((part) =>
      part.type === "tool" && part.state.status === "completed" ? [serializeToolContent(part.state.content)] : [],
    )
  if (message.type === "shell" && message.metadata?.background !== true) return [message.output?.output ?? ""]
  return []
}

export const truncateToolOutput = (value: string, max = TOOL_OUTPUT_MAX_CHARS) => {
  if (value.length <= max) return value

  // Count code points so a surrogate pair is never split.
  let end = 0
  let kept = 0
  for (const char of value) {
    if (kept === max) break
    end += char.length
    kept++
  }
  if (end === value.length) return value
  return `${value.slice(0, end)}\n[truncated]`
}

export const serializeToolContent = (content: ReadonlyArray<SessionMessage.ToolStateCompleted["content"][number]>) =>
  content
    .map((item) => {
      if (item.type === "text") return item.text
      return `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`
    })
    .join("\n")
