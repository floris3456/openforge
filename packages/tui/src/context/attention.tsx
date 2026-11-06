import type { Attention } from "@opencode/plugin/tui/context"
import { useRenderer } from "@opentui/solid"
import { createContext, onCleanup, useContext, type ParentProps } from "solid-js"
import { createTuiAttention } from "../attention"
import { createReport } from "../attention-report"
import { useConfig } from "../config"
import { useClient } from "./client"
import { useLog } from "./log"

const AttentionContext = createContext<Attention>()

export function AttentionProvider(props: ParentProps) {
  const config = useConfig()
  const client = useClient()
  const log = useLog({ component: "attention" })
  const attention = createTuiAttention({
    renderer: useRenderer(),
    config: config.data,
    report: createReport(() => client.api, log.debug),
  })
  onCleanup(() => attention.dispose())
  return <AttentionContext.Provider value={attention}>{props.children}</AttentionContext.Provider>
}

export function useAttention() {
  const attention = useContext(AttentionContext)
  if (!attention) throw new Error("AttentionProvider is missing")
  return attention
}
