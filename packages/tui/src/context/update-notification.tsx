// openforge's upgrade in the TUI: the CLI process installs a release and switches the background service to it
// while chats run (see packages/cli/src/upgrade). This screen shows how far that got and, once the service runs the
// new release, restarts itself on it once no other dialog is open, taking half-typed prompts along.
import { waitingMessage, type TitleOf, type UpgradeOutcome, type UpgradeState } from "@opencode/client/promise"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { useData } from "./data"
import { useExit } from "./exit"
import { useLog } from "./log"
import { useEpilogue } from "./epilogue"
import { useRoute } from "./route"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogUpdate, runningMessage } from "../component/dialog-update"

export type UpdateSource = {
  readonly subscribe: (notify: (state: UpgradeState) => void) => () => void
  /** Installs the latest release and switches to it while chats run. */
  readonly upgrade: () => Promise<UpgradeOutcome>
  /** Restarts this TUI on the release in use, back on `sessionID`. Absent when this TUI cannot restart itself. */
  readonly relaunch?: (sessionID?: string) => void
}

const updateDialog = Symbol("update dialog")
// How long a failed upgrade or a finished switch stays on screen as a toast.
const NOTICE_DURATION = 60_000
// A switch that waits says so until it goes on.
const WAITING_DURATION = 60 * 60_000
// The restart waits this long after the last key, so no key meant for this screen is lost.
const RESTART_QUIET = 300

export const { use: useUpdateNotification, provider: UpdateNotificationProvider } = createSimpleContext({
  name: "UpdateNotification",
  init: (props: { updater?: UpdateSource }) => {
    const exit = useExit()
    const epilogue = useEpilogue()
    const dialog = useDialog()
    const toast = useToast()
    const route = useRoute()
    const data = useData()
    const client = useClient()
    const log = useLog({ component: "update" })
    // A chat this screen has not loaded, such as one in another project, is read once so the switch can name it.
    const title: TitleOf = (sessionID) => {
      const session = data.session.get(sessionID)
      if (!session && !data.session.missing(sessionID)) void data.session.sync(sessionID).catch(() => undefined)
      return session?.title || undefined
    }
    const [state, setState] = createSignal<UpgradeState>()
    const [pending, setPending] = createSignal(false)

    const receive = (next: UpgradeState) => {
      if (JSON.stringify(state()) === JSON.stringify(next)) return
      setState(next)
      // Leaving a screen that cannot restart itself tells the user to start the new release.
      if (next.type === "switched" && !props.updater?.relaunch) epilogue.updatedVersion(next.version)
      // The dialog shows every step itself; without it, the steps that need attention become toasts. A switch in
      // progress has its own notice (see app.tsx).
      if (dialog.stack.length > 0) return
      if (next.type === "waiting")
        toast.show({ variant: "info", message: waitingMessage(next, title), duration: WAITING_DURATION })
      if (next.type === "failed") toast.show({ variant: "error", message: next.message, duration: NOTICE_DURATION })
      if (next.type === "switched" && !props.updater?.relaunch)
        toast.show({ variant: "success", message: runningMessage(next.version), duration: NOTICE_DURATION })
    }

    // Restart only while no other dialog is open, as it would be lost; the upgrade dialog is not. Half-typed prompts
    // are carried over to the new release (see default.ts in the CLI); a write the service has not answered yet is
    // not, whether it is still on its way or waiting to be resent, so the restart waits until the service has
    // answered it (or it was given up at its resend limit).
    const settled = () => (dialog.stack.length === 0 || dialog.key === updateDialog) && client.unanswered() === 0

    const restart = () => {
      const relaunch = props.updater?.relaunch
      if (!relaunch) return exit()
      const current = route.data
      epilogue.session()
      relaunch(current.type === "session" ? current.sessionID : undefined)
      exit()
    }

    const attempt = () => {
      if (!pending()) return
      if (!settled())
        return log.info("the restart waits for another dialog or a write the service has not answered", {
          dialogs: dialog.stack.length,
          unanswered: client.unanswered(),
        })
      setPending(false)
      restart()
    }
    // Restart after a pause in typing, so no key is lost, and after a dialog closed through keys still being handled.
    let quiet: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(quiet)
      quiet = setTimeout(attempt, RESTART_QUIET)
    }
    onCleanup(() => clearTimeout(quiet))

    createEffect(() => {
      const current = state()
      if (current?.type !== "switched" || !props.updater?.relaunch) return
      setPending(true)
    })
    // Each change of the dialog stack and of the writes on their way tries again, so the restart follows the last.
    createEffect(
      on([pending, settled], ([waiting]) => {
        if (waiting) schedule()
      }),
    )
    useKeyboard(() => {
      if (pending()) schedule()
    })

    onMount(() => {
      if (!props.updater) return
      onCleanup(props.updater.subscribe(receive))
    })

    const open = () => {
      const updater = props.updater
      if (!updater) return
      const active = state()?.type
      const running = active === "installing" || active === "switching" || active === "waiting"
      dialog.replace(
        () => (
          <DialogUpdate
            start={running || active === "switched" ? undefined : () => updater.upgrade()}
            state={state}
            restart={restart}
            restarts={updater.relaunch !== undefined}
            title={title}
          />
        ),
        undefined,
        { key: updateDialog },
      )
    }

    return {
      state,
      title,
      notification: () => {
        const current = state()
        if (current?.type === "available" || current?.type === "waiting") return current
        if (current?.type === "switched" && !props.updater?.relaunch) return current
        return undefined
      },
      open: props.updater ? open : undefined,
      /** The upgrade dialog is on top; it shows every step of the switch itself. */
      dialogOpen: () => dialog.key === updateDialog,
      restart,
    }
  },
})
