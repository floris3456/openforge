import type { ModelInfo, SessionMessageAssistant, SessionMessageInfo } from "../promise"

/**
 * What a chat's context meter counts against: the model's compaction point when it has one (a CLIProxyPacer client's
 * threshold), so a chat at the point shows 100%, else its context window. Undefined while neither is known. Every
 * client counts against this, so the TUI and the desktop app agree on it.
 */
export function contextLimit(limit: Pick<ModelInfo["limit"], "context" | "compact"> | undefined) {
  const tokens = limit?.compact ?? limit?.context
  return tokens && tokens > 0 ? tokens : undefined
}

/**
 * The assistant step whose tokens fill the context window now: the latest one after the last completed
 * compaction and before the revert boundary. Every client shows context usage from this step, so the TUI
 * and the desktop app agree on it.
 */
export function lastAssistantWithUsage(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string) {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1

  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex

  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )

  return messages.findLast(
    (message, index): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}
