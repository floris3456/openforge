import { createMemo, Show, type Accessor } from "solid-js"
import { usePacer } from "../context/pacer"
import { useTheme } from "../context/theme"
import { cacheLabel, clockTime, formatRemaining } from "./format"

// The toolbar's cache item (spec cliproxypacer-step-1, section 4), after the context and cost. While CPP is
// unreachable it keeps the last text, greyed, as it read when CPP last answered, with "as of 14:02"; it counts no
// more, so nothing ticks. It shows only while the chat's model is CPP's; one moved to another provider keeps the
// Requests tab. Clicking it opens the footer at the Requests tab. Greyed is the theme's faint text, dimmed
// as the toolbar dims what can't be used: a theme that sets no faint text has its muted text there, the item's own.

export interface PacerCacheText {
  readonly text: string
  readonly tone: "muted" | "warning" | "faint"
}

/** The cache item of the prompt's chat as it is drawn, or undefined when it shows nothing. */
export function usePacerCache(sessionID: Accessor<string | undefined>): Accessor<PacerCacheText | undefined> {
  const pacer = usePacer()
  if (!pacer) return () => undefined
  const view = createMemo(() => {
    const id = sessionID()
    if (!pacer.current(id) || pacer.state() === "no-pacer") return undefined
    return pacer.view(id!)
  })
  // Frozen at the first frame it is stale, so coming back changes it once, when the view read again replaces it.
  const asOf = createMemo<number | undefined>((previous) => {
    const current = view()
    if (!current || !pacer.stale(current)) return undefined
    return previous ?? pacer.status()?.asOf ?? current.value.asOf
  })
  const at = () => asOf() ?? pacer.now()
  const label = createMemo(() => {
    const current = view()
    return current && cacheLabel(current.value, at())
  })
  pacer.countdown(() => label()?.until !== undefined && asOf() === undefined)
  // A countdown keeps the widest width it had for the same deadline, so 10:00 → 9:59 changes only its digits.
  const digits = createMemo<{ key: string; width: number; text: string } | undefined>((previous) => {
    const current = label()
    if (current?.until === undefined) return undefined
    const text = formatRemaining(current.until - at())
    const key = `${current.text}${current.until}`
    const width = previous?.key === key ? Math.max(previous.width, text.length) : text.length
    return { key, width, text: text.padStart(width) }
  })
  return createMemo((): PacerCacheText | undefined => {
    const current = label()
    if (!current) return undefined
    const stale = asOf()
    return {
      text: current.text + (digits()?.text ?? "") + (stale === undefined ? "" : ` · as of ${clockTime(stale)}`),
      tone: stale === undefined ? current.tone : "faint",
    }
  })
}

export function PacerCacheItem(props: { sessionID?: string; item: PacerCacheText; separated: boolean }) {
  const theme = useTheme()
  const pacer = usePacer()
  const fg = () =>
    props.item.tone === "warning"
      ? theme.text.feedback.warning.base
      : props.item.tone === "faint"
        ? theme.text.faint
        : theme.text.muted
  return (
    <text
      fg={theme.text.muted}
      wrapMode="none"
      flexShrink={0}
      onMouseUp={() => {
        if (props.sessionID) pacer?.openRequests(props.sessionID)
      }}
    >
      <Show when={props.separated}> · </Show>
      <span style={{ fg: fg(), dim: props.item.tone === "faint" }}>{props.item.text}</span>
    </text>
  )
}
