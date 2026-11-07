import type { PacerRequest, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { createEffect, onCleanup, untrack, type Accessor } from "solid-js"
import { useData } from "../context/data"
import { usePacer } from "../context/pacer"

// Enter on a request row moves the chat to where that request ended (spec cliproxypacer-step-1, section 7): the end
// of the reply of the step whose message keeps the request's ID, exactly. A ping or a title goes to the reply before
// it; a request no message names (a failed attempt tried again, one CPP refused before choosing an account) goes to
// the chat's first step that started after it.

/** Where a request ended among a chat's messages; `exact` when a message names it. */
export function requestTarget(
  request: PacerRequest,
  messages: readonly SessionMessageInfo[],
): { messageID?: string; exact: boolean } {
  const steps = messages.filter((message): message is SessionMessageAssistant => message.type === "assistant")
  const named = steps.find((message) => message.proxyRequestID === request.id)
  if (named) return { messageID: named.id, exact: true }
  const after = steps.find((message) => message.time.created >= request.at)?.id
  if (request.kind === "ping" || request.kind === "title") {
    const before = steps.findLast(
      (message) => (message.time.streamed ?? message.time.completed ?? message.time.created) <= request.at,
    )
    return { messageID: before?.id ?? after, exact: false }
  }
  if (request.kind === "compaction") {
    const compaction = messages.findLast(
      (message) => message.type === "compaction" && message.time.created <= request.at,
    )
    if (compaction) return { messageID: compaction.id, exact: false }
  }
  return { messageID: after, exact: false }
}

/**
 * The session route's part: how to open its Requests tab (the toolbar's cache item, a cache notice opened for the
 * chat), and the move a row's Enter asked for once the chat's messages are there. Older messages are loaded until they
 * reach back to the request.
 */
export function usePacerSession(input: {
  sessionID: string
  ready: Accessor<boolean>
  open: () => void
  /** Moves to the end of a message's reply. */
  jump: (messageID: string) => void
  /** Moves to the end of the chat. */
  bottom: () => void
}) {
  const pacer = usePacer()
  const data = useData()
  if (!pacer) return
  onCleanup(pacer.attach(input.sessionID, { open: input.open }))
  // A cache notice opened for this chat opens its Requests tab, which moves to the request; one the tab didn't reach
  // before the chat was left is dropped, so coming back later doesn't open it.
  createEffect(() => {
    if (pacer.reveal()?.sessionID === input.sessionID) untrack(input.open)
  })
  onCleanup(() => {
    if (pacer.reveal()?.sessionID === input.sessionID) pacer.clearReveal()
  })
  createEffect(() => {
    const pending = pacer.jump()
    if (!pending || pending.sessionID !== input.sessionID || !input.ready()) return
    const messages = data.session.message.list(input.sessionID)
    const target = requestTarget(pending.request, messages)
    const reaches = messages.length === 0 || (messages[0]?.time.created ?? 0) <= pending.request.at
    if (!target.exact && !reaches && data.session.message.more(input.sessionID)) {
      if (!data.session.message.loading(input.sessionID))
        void data.session.message.loadMore(input.sessionID).catch(() => pacer.clearJump())
      return
    }
    untrack(() => {
      pacer.clearJump()
      if (target.messageID) input.jump(target.messageID)
      else input.bottom()
    })
  })
}
