export function canonicalToolName(name: string) {
  if (name === "bash") return "shell"
  // No `task` → `subagent`: `task` is CLIProxyPacer's task-list tool here, and the v1 migrations already rename the
  // old subagent tool's calls and permissions to `subagent`.
  if (name === "apply_patch") return "patch"
  return name
}

/**
 * The row of a call of CLIProxyPacer's `task` tool that makes a goal (`kind: "goal"`), as "Goal: <title>"; undefined
 * for every other call, which shows as before.
 */
export function goalCallLabel(tool: string, input: Record<string, unknown> | undefined) {
  if (tool !== "task" || input?.kind !== "goal") return
  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : ""
  return title ? `Goal: ${title}` : "Goal"
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return value
}

export function primitiveInputSummary(input: Record<string, unknown>, omit: readonly string[] = []) {
  const entries = Object.entries(input).filter(([key, value]) => {
    if (omit.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (entries.length === 0) return ""
  return `[${entries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`
}

export type ExecuteCall = {
  tool: string
  status: "running" | "completed" | "error"
  input?: Record<string, unknown>
  /** The call's metadata once it settled, as a direct call's own. */
  metadata?: Record<string, unknown>
}

export function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    if (!isRecord(call)) return []
    const tool = call.tool
    const status = call.status
    if (typeof tool !== "string" || (status !== "running" && status !== "completed" && status !== "error")) return []
    return [
      {
        tool,
        status,
        input: isRecord(call.input) ? call.input : undefined,
        ...(isRecord(call.metadata) ? { metadata: call.metadata } : {}),
      },
    ]
  })
}

export function executeCallSummary(call: ExecuteCall) {
  const goal = goalCallLabel(call.tool, call.input)
  if (goal) return goal
  const args = primitiveInputSummary(call.input ?? {}).replace(/\s+/g, " ")
  return `${call.tool}${args ? ` ${args}` : ""}`
}

export function webSearchProviderName(provider: unknown) {
  if (typeof provider !== "string" || !provider) return ""
  if (provider === "opencode") return "OpenCode"
  return `${provider[0].toUpperCase()}${provider.slice(1)}`
}

export function webSearchProviderLabel(provider: unknown) {
  const name = webSearchProviderName(provider)
  return name ? `Web Search via ${name}` : "Web Search"
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "streaming") return {}
  if (!("metadata" in state) || !state.metadata || typeof state.metadata !== "object") return {}
  if (Array.isArray(state.metadata)) return {}
  return state.metadata as Record<string, unknown>
}

export function toolDisplayContent(state: SessionMessageAssistantTool["state"]) {
  if (state.status === "streaming" || state.status === "running") return []
  return state.content ?? []
}

export function nonEmptyToolContent<T>(content: ReadonlyArray<T> | undefined): [T, ...T[]] | undefined {
  if (!content) return undefined
  const [first, ...rest] = content
  return first === undefined ? undefined : [first, ...rest]
}
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { isRecord } from "./record"
