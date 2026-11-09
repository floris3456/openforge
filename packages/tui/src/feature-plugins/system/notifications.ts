import { Plugin } from "@opencode/plugin/tui"
import type { Attention } from "@opencode/plugin/tui/context"
import type { AttentionHost } from "../../attention"
import { createAttentionEvents } from "../../attention-events"

// openforge: the TUI's notification events (`attention-events.ts`), in place of upstream's. They keep upstream's
// plugin ID, so `-opencode.notifications` in cli.json still turns them off.

export default Plugin.define({
  id: "opencode.notifications",
  setup(context) {
    // The events choose their sounds from the TUI's settings, which only its own attention host has.
    const host = context.attention
    if (!isHost(host)) return
    return createAttentionEvents({
      data: context.data,
      shells: (location) => context.client.shell.list({ location }).then((page) => page.data),
      settings: host.settings,
      raise: host.raise,
      ours: host.ours,
      failed: (sessionID, message) =>
        context.ui.toast.show({ sessionID, title: "Session failed", message, variant: "error" }),
    })
  },
})

function isHost(attention: Attention): attention is AttentionHost {
  return "raise" in attention && "settings" in attention && "ours" in attention
}
