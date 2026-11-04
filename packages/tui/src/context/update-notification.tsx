// openforge's upgrade in the TUI: the CLI process installs a release and switches the background service to it
// while chats run (see packages/cli/src/upgrade). This screen shows how far that got and, once the service runs the
// new release, restarts itself on it once no other dialog is open, taking half-typed prompts along.
import type { ContinuityWork } from "@opencode/client/promise"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "./helper"
import { useData } from "./data"
import { useExit } from "./exit"
import { useEpilogue } from "./epilogue"
import { useRoute } from "./route"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogUpdate } from "../component/dialog-update"

export type UpdateState =
  | { readonly type: "available"; readonly version: string }
  | { readonly type: "installing"; readonly version: string }
  /** `waiting` is what the running service's pause still waits for, as it changes. */
  | { readonly type: "switching"; readonly version: string; readonly waiting?: ReadonlyArray<ContinuityWork> }
  /**
   * Installed, not switched yet: the pause gave up while `waiting` ran and the switch tries again once that has
   * finished. Without `waiting` the running service cannot pause, and the switch waits until no chat is running.
   */
  | { readonly type: "waiting"; readonly version: string; readonly waiting?: ReadonlyArray<ContinuityWork> }
  | { readonly type: "switched"; readonly version: string }
  | { readonly type: "failed"; readonly version?: string; readonly message: string }

/** A chat's title, when this screen knows it. */
export type TitleOf = (sessionID: string) => string | undefined

/** What a release switch waits for: `a reply in "Fix the tests", webfetch in "Docs"`. */
export function describeWork(waiting: ReadonlyArray<ContinuityWork>, title: TitleOf = () => undefined) {
  if (waiting.length === 0) return "the work that was still running"
  return waiting
    .map((work) => {
      const what =
        work.kind === "step"
          ? work.name === "reply"
            ? "a reply"
            : "a step"
          : work.kind === "model"
            ? `a model call (${work.name})`
            : work.name
      if (!work.sessionID) return what
      const name = title(work.sessionID)
      return `${what} in ${name ? `"${name}"` : work.sessionID}`
    })
    .join(", ")
}

/** `Switching to openforge 0.1.1…`, with what the pause waits for. Without a version, a switch another screen runs. */
export function switchingMessage(version?: string, waiting?: ReadonlyArray<ContinuityWork>, title?: TitleOf) {
  const switching = version ? `Switching to openforge ${version}` : "Switching to a new openforge release"
  return waiting?.length ? `${switching}; waiting for ${describeWork(waiting, title)}…` : `${switching}…`
}

export function waitingMessage(state: Extract<UpdateState, { type: "waiting" }>, title?: TitleOf) {
  if (state.waiting)
    return `openforge ${state.version} is installed. The chats did not pause within 2 minutes; it switches once this has finished: ${describeWork(state.waiting, title)}`
  return `openforge ${state.version} is installed. The running service cannot pause; it switches once no chat is running.`
}

export type UpdateOutcome =
  | { readonly type: "current"; readonly version: string }
  | { readonly type: "unavailable"; readonly message: string }
  | { readonly type: "switched"; readonly from: string; readonly to: string }

export type UpdateSource = {
  readonly remote: boolean
  readonly subscribe: (notify: (state: UpdateState) => void) => () => void
  /** Installs the latest release and switches to it while chats run. */
  readonly upgrade: () => Promise<UpdateOutcome>
  /** Restarts this TUI on the release in use, back on `sessionID`. Absent when this TUI cannot restart itself. */
  readonly relaunch?: (sessionID?: string) => void
}

const updateDialog = Symbol("update dialog")

export const { use: useUpdateNotification, provider: UpdateNotificationProvider } = createSimpleContext({
  name: "UpdateNotification",
  init: (props: { updater?: UpdateSource }) => {
    const exit = useExit()
    const epilogue = useEpilogue()
    const dialog = useDialog()
    const toast = useToast()
    const route = useRoute()
    const data = useData()
    const title: TitleOf = (sessionID) => data.session.get(sessionID)?.title || undefined
    const [state, setState] = createSignal<UpdateState>()
    const [pending, setPending] = createSignal(false)

    const receive = (next: UpdateState) => {
      if (JSON.stringify(state()) === JSON.stringify(next)) return
      setState(next)
      // Leaving a screen that cannot restart itself tells the user to start the new release.
      if (next.type === "switched" && !props.updater?.relaunch) epilogue.updatedVersion(next.version)
      // The dialog shows every step itself; without it, the steps that need attention become toasts. A switch in
      // progress has its own notice (see app.tsx).
      if (dialog.stack.length > 0) return
      // Stays up while the switch waits.
      if (next.type === "waiting")
        toast.show({ variant: "info", message: waitingMessage(next, title), duration: 60 * 60_000 })
      if (next.type === "failed") toast.show({ variant: "error", message: next.message, duration: 60_000 })
      if (next.type === "switched" && !props.updater?.relaunch)
        toast.show({
          variant: "success",
          message: `openforge ${next.version} is running; restart to get the new screens`,
          duration: 60_000,
        })
    }

    // Restart only while no other dialog is open, as it would be lost; the upgrade dialog is not. Half-typed prompts
    // are carried over to the new release (see default.ts in the CLI).
    const settled = () => dialog.stack.length === 0 || dialog.key === updateDialog

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
    // Restart after a pause in typing, so no key is lost, and after a dialog closed through keys still being handled.
    let quiet: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(quiet)
      quiet = setTimeout(attempt, 300)
    }
    onCleanup(() => clearTimeout(quiet))

    createEffect(() => {
      const current = state()
      if (current?.type !== "switched" || !props.updater?.relaunch) return
      setPending(true)
    })
    // Tracks the dialog stack, so closing the last dialog schedules the restart.
    createEffect(() => {
      if (pending() && settled()) schedule()
    })
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
