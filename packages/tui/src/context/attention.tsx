import { useRenderer } from "@opentui/solid"
import { createContext, createSignal, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import { createTuiAttention, type AttentionHost } from "../attention"
import { createChatFilter } from "../attention-chats"
import { createReport } from "../attention-report"
import { useConfig } from "../config"
import { useClient } from "./client"
import { useData } from "./data"
import { useLog } from "./log"
import { useSessionTabs } from "./session-tabs"

const AttentionContext = createContext<AttentionHost>()

// openforge: the chats whose permissions this TUI accepts itself. The session route sets them from the same values
// its auto-reply reads, so a permission it accepts raises no notification.
type AutoReply = { register(sessions: Accessor<readonly string[]>): void }
const AutoReplyContext = createContext<AutoReply>()

export function AttentionProvider(props: ParentProps) {
  const config = useConfig()
  const client = useClient()
  const data = useData()
  const tabs = useSessionTabs()
  const log = useLog({ component: "attention" })
  const [autoReplied, setAutoReplied] = createSignal<Accessor<readonly string[]>>(() => [])
  const autoReply: AutoReply = {
    register(sessions) {
      setAutoReplied(() => sessions)
      onCleanup(() => setAutoReplied((current) => (current === sessions ? () => [] : current)))
    },
  }
  const attention = createTuiAttention({
    renderer: useRenderer(),
    config: config.data,
    report: createReport(() => client.api, log.debug),
    skip: createChatFilter({
      session: data.session,
      open: () => {
        const shown = tabs.current()
        const open = tabs.enabled() ? tabs.tabs().map((tab) => tab.sessionID) : []
        return shown ? [...open, shown] : open
      },
      autoReplied: (sessionID) => autoReplied()().includes(sessionID),
    }),
  })
  onCleanup(() => attention.dispose())
  return (
    <AutoReplyContext.Provider value={autoReply}>
      <AttentionContext.Provider value={attention}>{props.children}</AttentionContext.Provider>
    </AutoReplyContext.Provider>
  )
}

export function useAttention() {
  const attention = useContext(AttentionContext)
  if (!attention) throw new Error("AttentionProvider is missing")
  return attention
}

/** The attention host, where one runs: Settings plays a sound preview through it. */
export function useOptionalAttention() {
  return useContext(AttentionContext)
}

export function useAutoReply() {
  const autoReply = useContext(AutoReplyContext)
  if (!autoReply) throw new Error("AttentionProvider is missing")
  return autoReply
}
