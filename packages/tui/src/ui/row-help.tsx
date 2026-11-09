import type { BoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { stringWidth } from "../util/string-width"
import {
  DIALOG_INSET,
  DIALOG_LIST_INSET,
  DialogHeader,
  DialogLayout,
  dialogWidth,
  useDialog,
  type DialogContext,
} from "./dialog"

// openforge (spec row-help): the longer explanation of a list's row, opened with `?`. A dialog list shows it in its own
// place; a list on a full screen opens it as a popup with `openRowHelp`.

export type RowHelpContent = {
  title: string
  /** What the row does, how it works, what it depends on and its current limits. */
  help?: string
  /** The row's short description, shown when it has no help. */
  description?: string
}

export const ROW_HELP_NONE = "Nothing more to explain about this row."

export function openRowHelp(dialog: DialogContext, row: RowHelpContent) {
  dialog.replace(() => <RowHelp {...row} onBack={() => dialog.clear()} />)
}

export function RowHelp(props: RowHelpContent & { onBack: () => void }) {
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const shortcuts = Keymap.useShortcuts()
  const dialog = useDialog()
  // The dialog starts a quarter down the screen; its padding, header, footer and gaps take 9 more rows. A shorter text
  // keeps its own height, so the body is a clipped box rather than a scrollbox, which keeps its whole height.
  const rows = () => Math.max(3, Math.floor(dimensions().height * 0.75) - 9)
  const [top, setTop] = createSignal(0)
  const [height, setHeight] = createSignal(0)
  const scrollBy = (delta: number) => setTop((value) => Math.max(0, Math.min(height() - rows(), value + delta)))
  // Known before the first frame, so the footer's scroll hint is drawn with the text rather than a frame later.
  const overflows = () => {
    const width = Math.min(dialogWidth(dialog.size), dimensions().width - 2) - DIALOG_LIST_INSET * 2
    const text = props.help ?? [props.description, ROW_HELP_NONE].filter(Boolean).join("\n")
    return wrappedLines(text, width) > rows()
  }
  const back = () => ({ title: "back", key: ["esc", shortcuts.get("row.help")].filter(Boolean).join("/") })

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { id: "row.help", title: "Back to the list", group: "Dialog", run: props.onBack },
      { bind: "escape", title: "Back to the list", group: "Dialog", run: props.onBack },
      { bind: "up", title: "Scroll up", group: "Dialog", run: () => scrollBy(-1) },
      { bind: "down", title: "Scroll down", group: "Dialog", run: () => scrollBy(1) },
      { bind: "pageup", title: "Page up", group: "Dialog", run: () => scrollBy(-rows()) },
      { bind: "pagedown", title: "Page down", group: "Dialog", run: () => scrollBy(rows()) },
    ],
  }))

  return (
    <DialogLayout
      header={
        <box paddingLeft={DIALOG_LIST_INSET - DIALOG_INSET} paddingRight={DIALOG_LIST_INSET - DIALOG_INSET}>
          <DialogHeader title={props.title} onClose={props.onBack} />
        </box>
      }
      footer={{
        inset: DIALOG_LIST_INSET - DIALOG_INSET,
        actions: { secondary: [back(), ...(overflows() ? [{ title: "scroll", key: "↑/↓" }] : [])] },
      }}
    >
      <box
        paddingLeft={DIALOG_LIST_INSET - DIALOG_INSET}
        paddingRight={DIALOG_LIST_INSET - DIALOG_INSET}
        maxHeight={rows()}
        overflow="hidden"
      >
        <box
          flexShrink={0}
          marginTop={-Math.min(top(), Math.max(0, height() - rows()))}
          onSizeChange={function (this: BoxRenderable) {
            setHeight(this.height)
          }}
        >
          <Show
            when={props.help}
            fallback={
              <>
                <Show when={props.description}>
                  <text fg={theme.text.base} wrapMode="word">
                    {props.description}
                  </text>
                </Show>
                <text fg={theme.text.muted} wrapMode="word">
                  {ROW_HELP_NONE}
                </text>
              </>
            }
          >
            <text fg={theme.text.base} wrapMode="word">
              {props.help}
            </text>
          </Show>
        </box>
      </box>
    </DialogLayout>
  )
}

/** About the rows `text` takes wrapped at word boundaries to `width` cells (a word longer than a row counts as one). */
function wrappedLines(text: string, width: number) {
  return text.split("\n").reduce((total, line) => {
    const wrapped = line
      .split(" ")
      .filter((word) => word !== "")
      .reduce(
        (state, word) => {
          const size = stringWidth(word)
          if (state.used > 0 && state.used + 1 + size <= width) return { rows: state.rows, used: state.used + 1 + size }
          return { rows: state.rows + (state.used > 0 ? 1 : 0), used: size }
        },
        { rows: 1, used: 0 },
      )
    return total + wrapped.rows
  }, 0)
}
