import { createEffect, onCleanup } from "solid-js"
import { isSessionNotFoundError } from "@opencode/client"
import { useClient } from "./client"
import { useData } from "./data"
import { useEvent } from "./event"
import { useStorage } from "./storage"

// openforge: the sidebar's visibility and the state of its sections belong to the chat they were changed in, kept in
// the TUI's client-local storage by session ID, which every TUI window of the machine shares. A chat without its own
// state follows its root chat's; then the Sidebar setting is the visibility's default, and open the sections'.

type Chat = {
  sidebar?: "auto" | "hide"
  /** Whether the Todo section is unfolded. */
  todo?: boolean
  /** Whether the MCP section is unfolded. */
  mcp?: boolean
}

type State = { sessions: Record<string, Chat> }

function useStore() {
  return useStorage().store<State>("session-sidebar", { initial: { sessions: {} } })
}

export function useSidebarState() {
  const data = useData()
  const [store, update] = useStore()
  const own = <Key extends keyof Chat>(sessionID: string, key: Key) =>
    store.sessions[sessionID]?.[key] ?? store.sessions[data.session.root(sessionID)]?.[key]
  return {
    /** The chat's own visibility, else its root chat's; undefined leaves it to the Sidebar setting. */
    sidebar: (sessionID: string) => own(sessionID, "sidebar"),
    open: (sessionID: string, section: "todo" | "mcp") => own(sessionID, section) ?? true,
    set: (sessionID: string, change: Chat) =>
      update((draft) => {
        draft.sessions[sessionID] = { ...draft.sessions[sessionID], ...change }
      }),
  }
}

/**
 * Forgets the state of chats that no longer exist: a chat's as it is deleted while this TUI runs, and, once a start
 * after the first connection, those the service answers not found, deleted while no TUI ran. Mounted once, in App.
 */
export function pruneSidebarState() {
  const client = useClient()
  const event = useEvent()
  const [store, update] = useStore()
  const forget = (sessionIDs: string[]) =>
    update((draft) => sessionIDs.forEach((sessionID) => delete draft.sessions[sessionID])).catch((error) =>
      console.error("Failed to forget the sidebar state of deleted chats", error),
    )
  // Not only when this window's copy holds the chat: another window may have written it a moment ago.
  onCleanup(event.on("session.deleted", (evt) => void forget([evt.data.sessionID])))
  let checked = false
  createEffect(() => {
    if (checked || client.connection.status() !== "connected") return
    checked = true
    void (async () => {
      const gone: string[] = []
      // One at a time, so the chat on screen keeps the connection's first requests.
      for (const sessionID of Object.keys(store.sessions)) {
        const missing = await client.api.session.get({ sessionID }).then(() => false, isSessionNotFoundError)
        if (missing) gone.push(sessionID)
      }
      if (gone.length > 0) await forget(gone)
    })()
  })
}
