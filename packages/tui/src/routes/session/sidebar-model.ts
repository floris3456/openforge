import type { ModelRef, SessionInfo, SessionMessageInfo } from "@opencode/client"

/**
 * The model the sidebar's sections follow for a chat: the one picked in its prompt, also before it is sent, else the
 * chat's own. A subagent's chat has no prompt, and what the prompt would pick there is the main agent's: its own model,
 * else its last answer's (one started on the default model selects none). `messages` is read only then, so a chat's
 * other changes don't run its readers again.
 */
export function sidebarModel(input: {
  session: SessionInfo | undefined
  messages: () => readonly SessionMessageInfo[]
  picked: { providerID: string; modelID: string } | undefined
}): ModelRef | undefined {
  if (!input.session?.parentID) {
    if (input.picked) return { providerID: input.picked.providerID, id: input.picked.modelID }
    return input.session?.model
  }
  if (input.session.model) return input.session.model
  const last = input.messages().findLast((message) => message.type === "assistant")
  return last?.type === "assistant" ? last.model : undefined
}
