import type {
  PacerAccounts,
  PacerChat,
  PacerPromptChange,
  PacerRequest,
  PacerRequests,
  PacerStatus,
} from "@opencode/client"
import { SystemClock, type Clock, type TimerHandle } from "@opentui/core"
import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { PacerSwitches } from "../pacer/switches"
import { useClient } from "./client"
import { useData } from "./data"
import { useEvent } from "./event"
import { useRoute } from "./route"

// The TUI's one store of what CLIProxyPacer (CPP) says, read through the service's `pacer.*` routes and kept current
// by its `pacer.*` events (spec cliproxypacer-step-1, sections 4, 5 and 7). It costs nothing without CPP: until the
// status says CPP is set up and the shown chat is on it, nothing is read, ticked or drawn, and an event for another
// chat costs one comparison. Instant screens come from holding data before it is asked for: the shown chat's view
// and the first page of its requests for both filters are read when the chat is shown, never when a key opens a
// screen, and what changed is read ahead for every miss held.

/** The provider CPP's models are under (part 1, `PacerEndpoint.id`). */
export const PACER_PROVIDER = "cliproxypacer"

export type PacerFilter = "all" | "misses"

/** Chats whose view and pages stay held once they are no longer shown, to show them at once on going back. */
const HELD_CHATS = 8
/** What-changed answers held, by request ID. */
const HELD_PROMPTS = 200
/** What-changed reads ahead at once; one asked for now may run beside them. */
const PROMPT_READS = 3

/** A value as read, with the connection's epoch it was read in: one read before CPP came back is stale. */
export interface Held<Value> {
  readonly value: Value
  readonly epoch: number
}

export interface PacerPage {
  readonly items: PacerRequest[]
  readonly cursor?: string
  readonly asOf: number
  readonly epoch: number
}

interface ChatHeld {
  view?: Held<PacerChat>
  pages: { all?: PacerPage; misses?: PacerPage }
  more: { all: boolean; misses: boolean }
  /** Why its first page couldn't be read, while none is held. */
  failed?: string
}

export interface PacerJump {
  /** The chat the request belongs to: a subagent's own for a subagent's request. */
  readonly sessionID: string
  readonly request: PacerRequest
}

function createPacer(input: { clock: Clock }) {
  const client = useClient()
  const data = useData()
  const event = useEvent()
  const route = useRoute()
  const clock = input.clock
  const [store, setStore] = createStore<{
    status?: PacerStatus
    /** Counts the times the connection came back on; values read before the last one are stale until read again. */
    epoch: number
    accounts?: Held<PacerAccounts>
    chats: Record<string, ChatHeld>
    prompts: Record<string, PacerPromptChange | null>
  }>({ epoch: 0, chats: {}, prompts: {} })

  const state = () => store.status?.state ?? "unset"
  const shown = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  // A chat is on CPP when its model is one of CPP's, or one of its steps went through CPP. Not looked at while CPP
  // isn't set up.
  const onCPP = (sessionID: string) =>
    data.session.get(sessionID)?.model?.providerID === PACER_PROVIDER ||
    data.session.message
      .list(sessionID)
      .some((message) => message.type === "assistant" && message.model.providerID === PACER_PROVIDER)
  const shownOnCPP = createMemo(() => {
    const sessionID = shown()
    return sessionID !== undefined && state() !== "unset" && onCPP(sessionID)
  })
  // Its model now is one of CPP's: the one selected for it, else its last answer's (a chat on the default model
  // selects none). One moved to another provider keeps its requests, not CPP's cache, account or switches.
  const nowOnCPP = (sessionID: string) => {
    const selected = data.session.get(sessionID)?.model
    if (selected) return selected.providerID === PACER_PROVIDER
    const last = data.session.message.list(sessionID).findLast((message) => message.type === "assistant")
    return last?.type === "assistant" && last.model.providerID === PACER_PROVIDER
  }
  const shownNowOnCPP = createMemo(() => shownOnCPP() && nowOnCPP(shown()!))

  // One countdown clock for every screen, running only while a countdown is on screen. It ticks on the clock's whole
  // seconds and says the second, so a late tick still shows the right digits.
  const second = (time: number) => Math.floor(time / 1000) * 1000
  const [now, setNow] = createSignal(second(clock.now()))
  const touch = () => setNow(second(clock.now()))
  let tickers = 0
  let timer: TimerHandle | undefined
  // Scheduled before the second is published: a countdown that ends on it stops the clock it was ticked by.
  const tick = () => {
    timer = clock.setTimeout(tick, 1000 - (clock.now() % 1000))
    touch()
  }
  const countdown = (active: Accessor<boolean>) =>
    createEffect(() => {
      if (!active()) return
      onCleanup(() => {
        tickers--
        if (tickers > 0 || timer === undefined) return
        clock.clearTimeout(timer)
        timer = undefined
      })
      tickers++
      if (tickers === 1) tick()
    })

  const applyStatus = (next: PacerStatus) => {
    const previous = store.status?.state
    batch(() => {
      touch()
      if (next.state === "unset") {
        setStore({ status: next, accounts: undefined })
        setStore("chats", reconcile({}))
        setStore("prompts", reconcile({}))
        held.splice(0)
        promptOrder.splice(0)
        ahead.clear()
        cursorWant = undefined
        return
      }
      setStore("status", next)
      if (next.state === "on" && previous !== "on") setStore("epoch", (epoch) => epoch + 1)
    })
  }

  // Reads the status once the event stream is up, and again after each reconnect to the service, whose events in
  // between are lost.
  const [resync, setResync] = createSignal(0)
  createEffect(
    on(
      () => client.connection.status(),
      (status, previous) => {
        if (status !== "connected" || previous === "connected") return
        void client.api.experimental.pacer.status().then(
          (next) =>
            batch(() => {
              applyStatus(next)
              setResync((count) => count + 1)
            }),
          () => undefined,
        )
      },
    ),
  )

  // The accounts, once CPP is set up, and again each time it comes back.
  createEffect(
    on([() => store.epoch, () => state() !== "unset", resync], ([, set]) => {
      if (!set) return
      const epoch = store.epoch
      void client.api.experimental.pacer.accounts().then(
        (accounts) => {
          if (accounts === null || state() === "unset") return
          batch(() => {
            touch()
            setStore("accounts", { value: accounts, epoch })
          })
        },
        () => undefined,
      )
    }),
  )

  // The shown chat's view and first pages: when it is shown, when CPP comes back, after a reconnect.
  const held: string[] = []
  const hold = (sessionID: string) => {
    const index = held.indexOf(sessionID)
    if (index >= 0) held.splice(index, 1)
    held.push(sessionID)
    batch(() => {
      if (!store.chats[sessionID]) setStore("chats", sessionID, { pages: {}, more: { all: false, misses: false } })
      held.splice(0, Math.max(0, held.length - HELD_CHATS)).forEach((old) => setStore("chats", old, undefined!))
    })
  }
  createEffect(
    on([shown, shownOnCPP, () => store.epoch, resync], ([sessionID, active]) => {
      if (sessionID === undefined || !active) return
      untrack(() => {
        hold(sessionID)
        if (state() === "on" || state() === "unreachable") readView(sessionID)
        if (state() !== "on") return
        readFirst(sessionID, "all")
        readFirst(sessionID, "misses")
      })
    }),
  )

  const readView = (sessionID: string) => {
    const epoch = store.epoch
    void client.api.experimental.pacer.chat.get({ sessionID }).then(
      (view) => {
        if (view === null || !store.chats[sessionID]) return
        setView(view, epoch)
      },
      () => undefined,
    )
  }
  const setView = (view: PacerChat, epoch: number) =>
    batch(() => {
      touch()
      setStore("chats", view.sessionID, "view", { value: view, epoch })
    })

  // One read of a first page at a time per chat and filter, and at most one waiting behind it.
  const firstReads = new Map<string, { again: boolean }>()
  const readFirst = (sessionID: string, filter: PacerFilter) => {
    const key = `${sessionID} ${filter}`
    const running = firstReads.get(key)
    if (running) {
      running.again = true
      return
    }
    const entry = { again: false }
    firstReads.set(key, entry)
    const epoch = store.epoch
    void client.api.experimental.pacer.chat
      .requests({ sessionID, filter })
      .then(
        (page) => applyFirst(sessionID, filter, page, epoch),
        (error: unknown) => {
          if (!store.chats[sessionID] || store.chats[sessionID].pages[filter]) return
          setStore("chats", sessionID, "failed", error instanceof Error ? error.message : String(error))
        },
      )
      .finally(() => {
        firstReads.delete(key)
        if (entry.again && store.chats[sessionID] && state() === "on") readFirst(sessionID, filter)
      })
  }
  const applyFirst = (sessionID: string, filter: PacerFilter, fresh: PacerRequests, epoch: number) => {
    const chat = store.chats[sessionID]
    if (!chat) return
    const current = chat.pages[filter]
    const page = { ...mergeFirst(current && unwrap(current), fresh), epoch }
    const misses = chat.pages.misses
    const missIDs = new Set(misses?.items.map((item) => item.id))
    batch(() => {
      // Rows keep their identity by ID, so a list read again changes only what changed, in one frame.
      setStore("chats", sessionID, "pages", filter, reconcile(page, { key: "id" }))
      setStore("chats", sessionID, "failed", undefined)
      if (filter !== "all" || !misses) return
      fresh.items.forEach((item) => {
        const index = misses.items.findIndex((miss) => miss.id === item.id)
        if (index >= 0) setStore("chats", sessionID, "pages", "misses", "items", index, reconcile(item))
      })
    })
    readAhead(fresh.items)
    if (filter === "all" && misses && fresh.items.some((item) => item.miss && !missIDs.has(item.id)))
      readFirst(sessionID, "misses")
  }

  onCleanup(event.on("pacer.status", (event) => applyStatus(event.data.status)))
  onCleanup(
    event.on("pacer.accounts.updated", (event) => {
      if (state() === "unset") return
      batch(() => {
        touch()
        setStore("accounts", { value: event.data.accounts, epoch: store.epoch })
      })
    }),
  )
  onCleanup(
    event.on("pacer.chat.updated", (event) => {
      if (!store.chats[event.data.chat.sessionID]) return
      setView(event.data.chat, store.epoch)
    }),
  )
  onCleanup(
    event.on("pacer.requests.updated", (event) => {
      const sessionID = shown()
      if (sessionID === undefined || (event.data.sessionID !== undefined && event.data.sessionID !== sessionID)) return
      if (state() !== "on" || !store.chats[sessionID]) return
      readFirst(sessionID, "all")
    }),
  )

  const more = (sessionID: string, filter: PacerFilter) => {
    const chat = store.chats[sessionID]
    const cursor = chat?.pages[filter]?.cursor
    if (!chat || cursor === undefined || chat.more[filter] || state() !== "on") return
    setStore("chats", sessionID, "more", filter, true)
    void client.api.experimental.pacer.chat
      .requests({ sessionID, filter, cursor })
      .then(
        (next) => {
          const page = store.chats[sessionID]?.pages[filter]
          // A first page read again since then replaced where this one continues from.
          if (!page || page.cursor !== cursor) return
          const ids = new Set(page.items.map((item) => item.id))
          setStore("chats", sessionID, "pages", filter, (current) => ({
            ...current!,
            items: [...current!.items, ...next.items.filter((item) => !ids.has(item.id))],
            cursor: next.cursor,
          }))
          readAhead(next.items)
        },
        () => undefined,
      )
      .finally(() => {
        if (store.chats[sessionID]) setStore("chats", sessionID, "more", filter, false)
      })
  }

  // What changed, read ahead: every miss held, the row under the cursor, and the row asked for now. Each ID is read
  // once; a read that failed is tried again only when asked for.
  const promptOrder: string[] = []
  const promptReads = new Map<string, Promise<PacerPromptChange | null>>()
  const promptFailed = new Set<string>()
  const ahead = new Set<string>()
  let cursorWant: string | undefined
  const known = (requestID: string) => requestID in unwrap(store.prompts) || promptReads.has(requestID)
  const readAhead = (items: readonly PacerRequest[]) => {
    if (state() !== "on") return
    items.forEach((item) => {
      if (item.miss && !known(item.id) && !promptFailed.has(item.id)) ahead.add(item.id)
    })
    pump()
  }
  const pump = () => {
    while (promptReads.size < PROMPT_READS) {
      const requestID = cursorWant ?? ahead.values().next().value
      if (requestID === undefined) return
      if (requestID === cursorWant) cursorWant = undefined
      ahead.delete(requestID)
      if (!known(requestID)) readPrompt(requestID)
    }
  }
  const readPrompt = (requestID: string) => {
    const read = client.api.experimental.pacer.prompt({ requestID }).then(
      (change) => {
        promptFailed.delete(requestID)
        if (state() === "unset") return change
        batch(() => {
          setStore("prompts", requestID, change)
          promptOrder.push(requestID)
          promptOrder
            .splice(0, Math.max(0, promptOrder.length - HELD_PROMPTS))
            .forEach((old) => setStore("prompts", old, undefined!))
        })
        return change
      },
      (error: unknown) => {
        promptFailed.add(requestID)
        throw error
      },
    )
    promptReads.set(requestID, read)
    void read
      .catch(() => undefined)
      .finally(() => {
        promptReads.delete(requestID)
        pump()
      })
    return read
  }
  /** What changed in a request: held at once, else read now, beside the reads ahead. */
  const prompt = (requestID: string): Promise<PacerPromptChange | null> => {
    const answer = unwrap(store.prompts)[requestID]
    if (answer !== undefined) return Promise.resolve(answer)
    return promptReads.get(requestID) ?? readPrompt(requestID)
  }

  const sessions = new Map<string, { readonly open: () => void }>()
  const [jump, setJump] = createSignal<PacerJump>()

  return {
    status: () => store.status,
    state,
    /** The countdown clock's second; current while a countdown is on screen. */
    now,
    /** Keeps the countdown clock ticking while `active`; one clock for every screen. */
    countdown,
    /** Whether the countdown clock runs, for tests. */
    ticking: () => timer !== undefined,
    /** The chat is shown, CPP is set up and the chat used it: its requests show (the Requests tab). */
    active: (sessionID: string | undefined) => sessionID !== undefined && sessionID === shown() && shownOnCPP(),
    /**
     * {@link active}, and the chat's model is still one of CPP's: the toolbar's cache item, the Account section and the
     * switches draw.
     */
    current: (sessionID: string | undefined) => sessionID !== undefined && sessionID === shown() && shownNowOnCPP(),
    view: (sessionID: string) => store.chats[sessionID]?.view,
    accounts: () => store.accounts,
    page: (sessionID: string, filter: PacerFilter) => store.chats[sessionID]?.pages[filter],
    failed: (sessionID: string) => store.chats[sessionID]?.failed,
    loadingMore: (sessionID: string, filter: PacerFilter) => store.chats[sessionID]?.more[filter] ?? false,
    more,
    /** What changed in a request, if held: null when CPP has no such request. */
    held: (requestID: string) => store.prompts[requestID],
    prompt,
    /** The row under the cursor: read ahead next, unless it is held. */
    cursor(requestID: string) {
      if (state() !== "on" || known(requestID)) return
      cursorWant = requestID
      pump()
    },
    /** A value read before CPP last came back, or while it is unreachable, is shown greyed. */
    stale: (item: { readonly epoch: number } | undefined) =>
      state() === "unreachable" || (item !== undefined && item.epoch < store.epoch),
    /**
     * The model picker opened: the service reads CPP's models again in the background (spec section 1), and the
     * picker follows the model list's own events. Never waited on, and nothing is sent while CPP isn't set up.
     */
    refreshModels() {
      if (state() === "unset") return
      void client.api.experimental.pacer.refresh().catch(() => undefined)
    },
    /** Sets the chat's switches; its answer is the view the toolbar shows at once. */
    async update(sessionID: string, change: { warming?: boolean; compactBeforeCold?: boolean }) {
      const view = await client.api.experimental.pacer.chat.update({ sessionID, ...change })
      if (store.chats[sessionID]) setView(view, store.epoch)
      return view
    },
    /** The session route of a shown chat: how to open its Requests tab. */
    attach(sessionID: string, handlers: { readonly open: () => void }) {
      sessions.set(sessionID, handlers)
      return () => {
        if (sessions.get(sessionID) === handlers) sessions.delete(sessionID)
      }
    },
    openRequests: (sessionID: string) => sessions.get(sessionID)?.open(),
    /** Where Enter on a request row moves to, until the session route of its chat has moved there. */
    jump,
    requestJump: (next: PacerJump) => setJump(next),
    clearJump: () => setJump(undefined),
  }
}

/**
 * A first page read again over the rows held: the new page, then the older rows held beyond it, with the cursor
 * that continues after them. Rows only grow at the top, so a held row the new page lacks is older than all of it.
 */
export function mergeFirst(
  held: { readonly items: readonly PacerRequest[]; readonly cursor?: string } | undefined,
  fresh: PacerRequests,
) {
  if (!held || fresh.cursor === undefined) return { items: fresh.items, cursor: fresh.cursor, asOf: fresh.asOf }
  const ids = new Set(fresh.items.map((item) => item.id))
  const tail = held.items.filter((item) => !ids.has(item.id))
  if (tail.length === 0) return { items: fresh.items, cursor: fresh.cursor, asOf: fresh.asOf }
  return { items: [...fresh.items, ...tail], cursor: held.cursor, asOf: fresh.asOf }
}

export type Pacer = ReturnType<typeof createPacer>

const PacerContext = createContext<Pacer>()

/**
 * OpenTUI's system clock on the wall clock's time. CPP's times are Unix ms, while `SystemClock.now()` counts from the
 * start of the process (`performance.now()`), which made every countdown read as some 500,000 hours.
 */
export class WallClock extends SystemClock {
  override now() {
    return Date.now()
  }
}

export function PacerProvider(props: ParentProps<{ clock?: Clock }>) {
  const pacer = createPacer({ clock: props.clock ?? new WallClock() })
  return (
    <PacerContext.Provider value={pacer}>
      <PacerSwitches pacer={pacer} />
      {props.children}
    </PacerContext.Provider>
  )
}

/** The store, or undefined where no PacerProvider is mounted (component tests of upstream screens). */
export function usePacer() {
  return useContext(PacerContext)
}
