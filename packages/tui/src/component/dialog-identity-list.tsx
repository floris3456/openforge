import { createMemo, createResource, onMount } from "solid-js"
import type { PacerIdentity } from "@opencode/client"
import { DIALOG_LIST_INSET, type DialogContext, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { usePacer, type Pacer } from "../context/pacer"
import { useTheme } from "../context/theme"
import { useToast, type ToastContext } from "../ui/toast"
import { errorMessage } from "../util/error"

// The owner's `/identity` (the workspace's spec `docs/specs/agent-badges.md`, section 1, item 6): a picker built like
// the session list over the chat's project's agents' identities, the most recently active first, and the command's
// two forms, `/identity <session id>` and `/identity new`. CLIProxyPacer keeps the identities; no agent tool reaches
// any of this.

/** What a link's toast says: "This chat is now floris's lead (Agent badges plan)". */
export function linkedMessage(identity: PacerIdentity, changed = true) {
  const who = `${identity.name}${identity.title ? ` (${identity.title})` : ""}`
  return changed ? `This chat is now ${who}` : `This chat already is ${who}`
}

/** When an identity was last active, as its row says it: "active 3 min ago", "active 2 h ago", "never active". */
export function lastActive(at: number | undefined, now: number) {
  if (at === undefined) return "never active"
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return "active just now"
  if (minutes < 60) return `active ${minutes} min ago`
  if (minutes < 48 * 60) return `active ${Math.floor(minutes / 60)} h ago`
  return `active ${Math.floor(minutes / (24 * 60))} d ago`
}

/**
 * `/identity`'s forms and the picker's choice: links the chat, and a toast says what it is now, or why not. The
 * argument `new` gives the chat its own identity again; any other is a session ID.
 */
export async function linkIdentity(
  pacer: Pacer,
  toast: ToastContext,
  sessionID: string,
  to: { identity: string } | { session: string } | { new: true },
) {
  return pacer.linkIdentity(sessionID, to).then(
    (linked) => {
      toast.show({ variant: "success", message: linkedMessage(linked.identity, linked.changed), duration: 5000 })
      return linked
    },
    (error) => {
      toast.show({ variant: "error", message: `Could not link this chat: ${errorMessage(error)}`, duration: 5000 })
      return undefined
    },
  )
}

/** `/identity` with an argument: `new`, else the session ID of the chat whose identity to take. */
export function identityTarget(input: string): { session: string } | { new: true } {
  const given = input.trim()
  return given === "new" ? { new: true } : { session: given }
}

export function DialogIdentityList(props: { sessionID: string; now?: () => number }) {
  const dialog = useDialog()
  const pacer = usePacer()!
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const [list] = createResource(() =>
    pacer.identityList(props.sessionID).then(
      (identities) => ({ identities, error: undefined }),
      (error: unknown) => ({ identities: undefined, error: errorMessage(error) }),
    ),
  )
  const options = createMemo(() => {
    const now = props.now?.() ?? Date.now()
    return (list()?.identities?.items ?? []).map((identity) => ({
      title: identity.name,
      value: identity.id,
      description: identity.title,
      footer: lastActive(identity.lastActive, now),
      // Typing filters on its name, its title, or a session ID of one of its chats.
      searchText: [identity.title ?? "", ...identity.chats.map((chat) => chat.chat)].join(" "),
    }))
  })
  const message = () => {
    const read = list()
    if (!read) return { text: "Loading identities…", error: false }
    if (read.error) return { text: read.error, error: true }
    return {
      text: "No agent of this project has an identity yet: a chat gets one at its first board action.",
      error: false,
    }
  }
  const empty = () => (
    <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
      <text fg={message().error ? theme.text.feedback.error.base : theme.text.muted}>{message().text}</text>
    </box>
  )

  onMount(() => dialog.setSize("large"))

  return (
    <DialogSelect
      title="Link this chat to an agent's identity"
      placeholder="Search by name, title or session ID"
      options={options()}
      current={list()?.identities?.current}
      emptyView={empty()}
      noMatchView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
          <text fg={theme.text.muted}>No identity matches</text>
        </box>
      }
      onSelect={(option) => {
        dialog.clear()
        void linkIdentity(pacer, toast, props.sessionID, { identity: option.value })
      }}
    />
  )
}

/**
 * `/identity`, beside `/rename`: offered only while CLIProxyPacer keeps agents' identities, so a TUI against a CPP
 * without them has no such command. Without an argument it opens the picker.
 */
export function identityCommands(input: {
  readonly pacer: Pacer | undefined
  readonly dialog: DialogContext
  readonly toast: ToastContext
  readonly sessionID: () => string
}) {
  const pacer = input.pacer
  if (!pacer?.identities()) return []
  return [
    {
      title: "Link agent identity",
      id: "session.identity",
      group: "Session",
      slash: { name: "identity", arguments: true as const },
      run: (args?: string) => {
        if (args === undefined || !args.trim())
          return input.dialog.replace(() => <DialogIdentityList sessionID={input.sessionID()} />)
        void linkIdentity(pacer, input.toast, input.sessionID(), identityTarget(args))
      },
    },
  ]
}
