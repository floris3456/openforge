import type { SessionMessageAssistant } from "@opencode/client"
import { Pacer } from "@opencode/schema/pacer"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

type Retry = NonNullable<SessionMessageAssistant["retry"]>

/**
 * What a chat waiting on a retry shows of it, for the parent's subagent row and the Subagents tab: "waiting for a free
 * login · retry in 4m 12s" while no login could serve its model, else "retry in 12s · attempt 3".
 */
export function retryWait(retry: Retry, now: number) {
  const seconds = Math.max(0, Math.ceil((retry.at - now) / 1_000))
  const time = seconds > 0 ? `retry in ${duration(seconds)}` : "retry due"
  if (Pacer.noFreeLogin(retry.error.status, retry.error.response?.body ?? retry.error.message))
    return `waiting for a free login · ${time}`
  return `${time} · attempt ${retry.attempt}`
}

/** {@link retryWait} of `retry`, counting down each second while there is one. */
export function useRetryWait(retry: Accessor<Retry | undefined>) {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    const at = retry()?.at
    if (at === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= at) clearInterval(timer)
    }, 1_000)
    onCleanup(() => clearInterval(timer))
  })
  return () => {
    const current = retry()
    return current && retryWait(current, now())
  }
}

function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}
