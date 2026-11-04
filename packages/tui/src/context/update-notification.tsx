// openforge's upgrade in the TUI: the CLI process installs a release and switches the background service to it
// once no chat is running (see packages/cli/src/upgrade). This screen shows how far that got and, once the
// service runs the new release, restarts itself on it when the user is not in the middle of something.
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useEpilogue } from "./epilogue"
import { usePromptRef } from "./prompt"
import { useRoute } from "./route"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogUpdate } from "../component/dialog-update"

export type UpdateState =
  | { readonly type: "available"; readonly version: string }
  | { readonly type: "installing"; readonly version: string }
  | { readonly type: "ready"; readonly version: string }
  | { readonly type: "switching"; readonly version: string }
  | { readonly type: "switched"; readonly version: string }
  | { readonly type: "failed"; readonly version?: string; readonly message: string }

export type UpdateOutcome =
  | { readonly type: "current"; readonly version: string }
  | { readonly type: "unavailable"; readonly message: string }
  | { readonly type: "switched"; readonly from: string; readonly to: string }

export type UpdateSource = {
  readonly remote: boolean
  readonly subscribe: (notify: (state: UpdateState) => void) => () => void
  /** Installs the latest release and switches to it once no chat is running. */
  readonly upgrade: () => Promise<UpdateOutcome>
  /** Restarts this TUI on the release in use, back on `sessionID`. Absent when this TUI cannot restart itself. */
  readonly relaunch?: (sessionID?: string) => void
}

export function readyMessage(version: string) {
  return `openforge ${version} is ready; switches when no chat is running`
}

export const { use: useUpdateNotification, provider: UpdateNotificationProvider } = createSimpleContext({
  name: "UpdateNotification",
  init: (props: { updater?: UpdateSource }) => {
    const exit = useExit()
    const epilogue = useEpilogue()
    const dialog = useDialog()
    const toast = useToast()
    const route = useRoute()
    const promptRef = usePromptRef()
    const [state, setState] = createSignal<UpdateState>()
    const [pending, setPending] = createSignal(false)

    const receive = (next: UpdateState) => {
      const previous = state()
      if (previous?.type === next.type && "version" in next && previous.version === next.version) return
      setState(next)
      // The dialog shows every step itself; without it, the steps that need attention become toasts.
      if (dialog.stack.length > 0) return
      if (next.type === "ready") toast.show({ variant: "info", message: readyMessage(next.version), duration: 60_000 })
      if (next.type === "switching")
        toast.show({ variant: "info", message: `Switching to openforge ${next.version}…`, duration: 30_000 })
      if (next.type === "failed") toast.show({ variant: "error", message: next.message, duration: 60_000 })
      if (next.type === "switched" && !props.updater?.relaunch)
        toast.show({
          variant: "success",
          message: `openforge ${next.version} is running; restart to get the new screens`,
          duration: 60_000,
        })
    }

    // Restart only between tasks: a typed prompt or an open dialog would be lost.
    const settled = () => {
      const prompt = promptRef.current?.current
      return (
        dialog.stack.length === 0 &&
        (!prompt || (prompt.text.trim() === "" && !prompt.files?.length && prompt.pasted.length === 0))
      )
    }

    const restart = () => {
      const relaunch = props.updater?.relaunch
      if (!relaunch) return exit()
      const current = route.data
      epilogue.session()
      relaunch(current.type === "session" ? current.sessionID : undefined)
      exit()
    }

    const attempt = () => {
      if (!pending() || !settled()) return
      setPending(false)
      restart()
    }

    createEffect(() => {
      const current = state()
      if (current?.type !== "switched" || !props.updater?.relaunch) return
      setPending(true)
    })
    createEffect(() => {
      // Tracks the dialog stack, so closing the last dialog retries.
      if (pending() && dialog.stack.length === 0) attempt()
    })
    // Clearing or sending the prompt happens through keys, and a sent prompt leaves the composer a moment later.
    useKeyboard(() => {
      if (pending()) setTimeout(attempt, 300)
    })

    onMount(() => {
      if (!props.updater) return
      onCleanup(props.updater.subscribe(receive))
    })

    const open = () => {
      const updater = props.updater
      if (!updater) return
      const active = state()?.type
      const running = active === "installing" || active === "ready" || active === "switching"
      dialog.replace(() => (
        <DialogUpdate
          start={running || active === "switched" ? undefined : () => updater.upgrade()}
          state={state}
          restart={restart}
        />
      ))
    }

    return {
      state,
      notification: () => {
        const current = state()
        if (current?.type === "available" || current?.type === "ready") return current
        if (current?.type === "switched" && !props.updater?.relaunch) return current
        return undefined
      },
      open: props.updater ? open : undefined,
      restart,
    }
  },
})
