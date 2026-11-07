import { createContext, useContext } from "solid-js"

export interface ComposerHint {
  label: string
  shortcut: string
}

export interface ComposerTab {
  id: string
  label: string
  hints?: () => ComposerHint[]
  /** Tabs show by order, then as they registered: one registered later still shows after one of a lower order. */
  order?: number
}

export const ComposerContext = createContext<{
  register: (tab: ComposerTab) => () => void
  active: (id: string) => boolean
  /** Makes a tab the active one, as ←/→ do: a tab asked for from outside the composer (a cache notice opened). */
  select: (id: string) => void
  close: () => void
}>()

export function useComposerTab() {
  const ctx = useContext(ComposerContext)
  if (!ctx) throw new Error("useComposerTab must be used within a Composer")
  return ctx
}
