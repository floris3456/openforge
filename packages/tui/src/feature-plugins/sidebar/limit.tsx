import { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import { useUsageLimits } from "../../component/usage"
import { useLocal } from "../../context/local"
import { sidebarModel } from "../../routes/session/sidebar-model"
import { formatDollars, usageLevel } from "../../util/usage-limits"

/** What the workspace's limits leave for the selected model; hidden when no limit applies to it. */
export function SidebarLimit(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const local = useLocal()
  const limits = useUsageLimits()
  const state = createMemo(() => {
    const selected = sidebarModel({
      session: props.context.data.session.get(props.sessionID),
      messages: props.context.data.session.message.list(props.sessionID),
      picked: local.model.current(),
    })
    const model = limits.models().find((item) => item.providerID === selected?.providerID && item.id === selected?.id)
    const usage = model && limits.usage(model)
    if (!model || !usage) return
    const level = usageLevel(usage, model)
    return { left: usage.left, danger: level === "out" || level === "reached" }
  })

  return (
    <Show when={state()}>
      {(value) => (
        <box>
          <text fg={theme.text.base}>
            <b>Limit</b>
          </text>
          <text fg={value().danger ? theme.text.feedback.error.base : theme.text.muted}>
            {formatDollars(value().left)} remaining
          </text>
        </box>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.limit",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarLimit context={context} sessionID={props.sessionID} />,
    })
  },
})
