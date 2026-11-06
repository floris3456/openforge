import { Keymap } from "../context/keymap"
import { useRoute } from "../context/route"
import type { Pacer } from "../context/pacer"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

// The shown chat's two switches on CPP (spec cliproxypacer-step-1, section 6): `<leader>k` and `<leader>j`, the keys
// OpenCodePlus has, and their palette entries. They exist only for a chat whose model is CPP's. The answer of
// `chat.update` is the chat's view after the change, so the toolbar shows it at once.

export function PacerSwitches(props: { pacer: Pacer }) {
  const route = useRoute()
  const toast = useToast()
  const shown = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const enabled = () => {
    const state = props.pacer.state()
    return props.pacer.current(shown()) && state !== "unset" && state !== "no-pacer"
  }

  const flip = async (key: "warming" | "compactBeforeCold") => {
    const sessionID = shown()
    if (sessionID === undefined) return
    const view = props.pacer.view(sessionID)?.value
    if (!view) {
      toast.show({
        variant: "warning",
        message: "CLIProxyPacer knows nothing of this chat yet: switch it after its first reply",
      })
      return
    }
    const on = !view.switches[key]
    const next = await props.pacer.update(sessionID, { [key]: on }).catch((error: unknown) => {
      toast.show({ variant: "error", message: errorMessage(error) })
      return undefined
    })
    if (!next) return
    toast.show({
      variant: "info",
      message:
        key === "warming"
          ? `Cache warming ${next.switches.warming ? "on" : "off"} for this chat`
          : `Compact before cold ${next.switches.compactBeforeCold ? "on" : "off"} for this chat`,
    })
  }

  // Read here, so the layer follows it: a chat not on CPP has neither key nor palette entry.
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "pacer.warming.toggle",
        title: "Cache warming for this chat",
        group: "CLIProxyPacer",
        palette: true,
        enabled: enabled(),
        run: () => void flip("warming"),
      },
      {
        id: "pacer.compact_before_cold.toggle",
        title: "Compact before cold for this chat",
        group: "CLIProxyPacer",
        palette: true,
        enabled: enabled(),
        run: () => void flip("compactBeforeCold"),
      },
    ],
  }))
  return null
}
