import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { type LocationRef, type ShellInfo } from "@opencode/client"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import stripAnsi from "strip-ansi"
import { useClient } from "../context/client"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogFooter, DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { followShellOutput } from "../util/shell-output"

const PAGE_BYTES = 64 * 1024

export function DialogShellOutput(props: { shell: ShellInfo; location: LocationRef }) {
  const client = useClient()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const [info, setInfo] = createSignal(props.shell)
  const [output, setOutput] = createSignal<string>()
  const [omitted, setOmitted] = createSignal(false)
  const [error, setError] = createSignal("")
  const text = createMemo(() => stripAnsi(output() ?? "").replace(/\r\n?/g, "\n"))
  const height = () => Math.max(3, Math.floor(dimensions().height * 0.6) - 6)
  let scroll: ScrollBoxRenderable | undefined

  dialog.setSize("xlarge")
  dialog.setCentered(true)

  createEffect(() => {
    // The running-shell inventory drops exited commands. Keep this view tied to
    // the opened ID and its original Location, not the list's current selection.
    const location = { directory: props.location.directory }
    const stop = followShellOutput(
      () => client.api,
      { id: props.shell.id, location, limit: PAGE_BYTES },
      {
        connected: () => setError(""),
        reset: (earlier) => {
          setOutput("")
          setOmitted(earlier)
        },
        output: (text) =>
          setOutput((previous) => {
            const next = (previous ?? "") + text
            if (next.length > PAGE_BYTES) setOmitted(true)
            return next.slice(-PAGE_BYTES)
          }),
        exited: (shell) => setInfo(shell),
        failed: (missing) =>
          setError(missing ? "Shell output is no longer available." : "Unable to read shell output. Retrying…"),
      },
    )
    onCleanup(stop)
  })

  const status = () => {
    if (info().status === "running") return "Running"
    if (info().status === "timeout") return "Timed out"
    if (info().status === "killed") return "Killed"
    return info().exit === undefined ? "Exited" : `Exited · code ${info().exit}`
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "up", title: "Scroll output up", group: "Shell", run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll output down", group: "Shell", run: () => scroll?.scrollBy(1) },
      { bind: "pageup", title: "Previous output page", group: "Shell", run: () => scroll?.scrollBy(-height()) },
      { bind: "pagedown", title: "Next output page", group: "Shell", run: () => scroll?.scrollBy(height()) },
      { bind: "home", title: "First loaded output", group: "Shell", run: () => scroll?.scrollTo(0) },
      { bind: "end", title: "Follow shell output", group: "Shell", run: () => scroll?.scrollTo(Infinity) },
    ],
  }))

  return (
    <DialogLayout
      header={
        <DialogHeader
          gap={dimensions().width < 60 ? 1 : 2}
          titleView={
            <text fg={theme.text.base} attributes={TextAttributes.BOLD} flexGrow={1}>
              Shell output
            </text>
          }
        >
          <text fg={theme.text.muted}>{status()}</text>
        </DialogHeader>
      }
      legacyFooter={
        <DialogFooter
          actions={{
            secondary: [
              { title: "scroll", key: "↑/↓" },
              { title: "follow", key: "end" },
              { title: "back", key: "esc" },
            ],
          }}
        />
      }
    >
      <box gap={1}>
        <text fg={theme.text.muted} maxHeight={3} wrapMode="word">
          {props.shell.command}
        </text>
        <Show when={omitted()}>
          <text fg={theme.text.muted}>Earlier output omitted · showing recent output</text>
        </Show>
        <scrollbox
          id="shell-output-scroll"
          ref={(value: ScrollBoxRenderable) => (scroll = value)}
          height={height()}
          stickyScroll
          stickyStart="bottom"
          scrollbarOptions={{ visible: false }}
        >
          <text fg={theme.text.base} wrapMode="word">
            {text() ||
              (output() === undefined
                ? "Loading output…"
                : "No captured output. Output redirected to files is not shown here.")}
          </text>
        </scrollbox>
        <Show when={error()}>
          <text fg={theme.text.feedback.error.base}>{error()}</text>
        </Show>
      </box>
    </DialogLayout>
  )
}
