import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Keymap } from "../context/keymap"
import { useNewDesigns } from "../config"
import { useTheme } from "../context/theme"
import { readyMessage, type UpdateOutcome, type UpdateState } from "../context/update-notification"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { errorMessage } from "../util/error"
import { Spinner } from "./spinner"

export function DialogUpdate(props: {
  /** Starts an upgrade; absent while one is already under way. */
  start?: () => Promise<UpdateOutcome>
  state: () => UpdateState | undefined
  restart: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const newDesigns = useNewDesigns()
  const [error, setError] = createSignal<string>()
  const [active, setActive] = createSignal(0)
  let closed = false
  onCleanup(() => (closed = true))

  dialog.setCentered(true)

  const [outcome] = createResource(
    () => props.start,
    (start) =>
      start().catch((cause) => {
        if (!closed) setError(errorMessage(cause))
        return undefined
      }),
  )
  const view = createMemo(() => {
    const current = props.state()
    // Progress reported while the upgrade runs wins over its still pending outcome.
    if (current && current.type !== "available" && current.type !== "failed") return current
    const message = error()
    if (message) return { type: "failed" as const, message }
    if (outcome.loading) return { type: "checking" as const }
    const result = outcome()
    if (result?.type === "current") return result
    if (result?.type === "unavailable") return result
    return current ?? { type: "checking" as const }
  })
  const buttons = createMemo(() => {
    const type = view().type
    const close = { label: "Close", run: () => dialog.clear() }
    if (type === "switched") return [close, { label: "Restart", run: props.restart }]
    return [close]
  })

  createEffect(() => setActive(Math.max(0, buttons().length - 1)))

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Confirm upgrade action",
        group: "Dialog",
        run: () => void buttons()[newDesigns() ? buttons().length - 1 : active()]?.run(),
      },
      ...(newDesigns() ? [] : ["left", "right", "tab", "shift+tab"]).map((bind) => ({
        bind,
        title: bind === "left" || bind === "shift+tab" ? "Previous upgrade action" : "Next upgrade action",
        group: "Dialog",
        run: () => {
          const count = buttons().length
          if (count) setActive((value) => (value + 1) % count)
        },
      })),
    ],
  }))

  return (
    <DialogLayout
      header={<DialogHeader title="Upgrade openforge" />}
      footer={{
        actions: {
          primary: buttons().map((button, index) => ({
            title: button.label.toLowerCase(),
            key: index === buttons().length - 1 ? "enter" : undefined,
            onTrigger: () => void button.run(),
          })),
        },
      }}
      legacyFooter={
        <box flexDirection="row" justifyContent="flex-end">
          <For each={buttons()}>
            {(button, index) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() === index() ? theme.background.action.primary.focused : undefined}
                onMouseUp={() => void button.run()}
              >
                <text fg={active() === index() ? theme.text.action.primary.focused : theme.text.muted}>
                  {button.label}
                </text>
              </box>
            )}
          </For>
        </box>
      }
    >
      <Show when={view()} keyed>
        {(current) => (
          <Switch>
            <Match when={current.type === "checking"}>
              <Spinner shimmer={theme.text.base}>Checking for a new openforge release…</Spinner>
            </Match>
            <Match when={current.type === "installing" && current}>
              {(state) => <Spinner shimmer={theme.text.base}>{`Installing openforge ${state().version}…`}</Spinner>}
            </Match>
            <Match when={current.type === "ready" && current}>
              {(state) => (
                <text fg={theme.text.muted} wrapMode="word">
                  {readyMessage(state().version)}
                </text>
              )}
            </Match>
            <Match when={current.type === "switching" && current}>
              {(state) => <Spinner shimmer={theme.text.base}>{`Switching to openforge ${state().version}…`}</Spinner>}
            </Match>
            <Match when={current.type === "switched" && current}>
              {(state) => (
                <text fg={theme.text.muted} wrapMode="word">
                  {`openforge ${state().version} is running. Restart opens this chat again on it.`}
                </text>
              )}
            </Match>
            <Match when={current.type === "current" && current}>
              {(state) => <text fg={theme.text.muted}>{`openforge ${state().version} is up to date.`}</text>}
            </Match>
            <Match when={current.type === "unavailable" && current}>
              {(state) => (
                <text fg={theme.text.muted} wrapMode="word">
                  {state().message}
                </text>
              )}
            </Match>
            <Match when={current.type === "failed" && current}>
              {(state) => (
                <text fg={theme.text.feedback.error.base} wrapMode="word">
                  {state().message}
                </text>
              )}
            </Match>
          </Switch>
        )}
      </Show>
    </DialogLayout>
  )
}
