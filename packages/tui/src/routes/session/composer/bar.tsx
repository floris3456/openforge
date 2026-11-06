import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../../../context/theme"
import { stringWidth } from "../../../util/string-width"
import type { ComposerHint } from "./context"

// The composer's tab bar and its hint line, each on one line at any width. CLIProxyPacer's Requests tab (spec
// cliproxypacer-step-1, section 7) is a fourth tab, which made both wrap label by label in a narrow window. The bar
// shows every tab while they fit beside "esc", else only the active one with ←/→; the hints show from the first while
// they fit, "tabs ←/→" last and only beside the full bar. Chosen from the width alone, in the frame that has it, so a
// resize draws the new layout at once.

/** Columns the composer's frame takes from the session's width: its border and padding, and the rows' indent. */
export const COMPOSER_FRAME = 5
const GAP = 2
const ESC = "esc"
const ARROWS = "←/→"
const TABS: ComposerHint = { label: "tabs", shortcut: ARROWS }

const hintWidth = (hint: ComposerHint) => stringWidth(hint.label) + 1 + stringWidth(hint.shortcut)

export function composerBar(input: {
  readonly width: number
  readonly labels: readonly string[]
  readonly hints: readonly ComposerHint[]
}) {
  const many = input.labels.length > 1
  const labels = input.labels.reduce((sum, label, index) => sum + stringWidth(label) + (index > 0 ? GAP : 0), 0)
  const all = !many || labels + GAP + stringWidth(ESC) <= input.width
  const hints: ComposerHint[] = []
  let used = 0
  for (const hint of input.hints) {
    const next = used + (hints.length > 0 ? GAP : 0) + hintWidth(hint)
    if (next > input.width) break
    hints.push(hint)
    used = next
  }
  const tabs =
    many && all && hints.length === input.hints.length && used + (used > 0 ? GAP : 0) + hintWidth(TABS) <= input.width
  return { all, hints, tabs }
}

/** The bar with only the active tab: its label, and ←/→ when there are others. */
export function ActiveTab(props: { label: string; more: boolean }) {
  const theme = useTheme()
  return (
    <box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
        {props.label}
      </text>
      <Show when={props.more}>
        <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
          {ARROWS}
        </text>
      </Show>
    </box>
  )
}
