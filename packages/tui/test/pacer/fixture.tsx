/** @jsxImportSource @opentui/solid */
import type {
  OpenCodeEvent,
  PacerAccounts,
  PacerChat,
  PacerNotice,
  PacerPromptChange,
  PacerRequest,
  PacerSettings,
  PacerStatus,
  SessionMessageInfo,
} from "@opencode/client"
import { PacerWire } from "@opencode/core/pacer/wire"
import type { Plugin } from "@opencode/plugin/tui"
import { SessionID } from "@opencode/schema/session-id"
import { TextAttributes } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { onMount, type JSX } from "solid-js"
import { ConfigProvider, useConfig, type Config } from "../../src/config"
import type { TuiKeybind } from "../../src/config/keybind"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { PacerProvider, usePacer, type Pacer } from "../../src/context/pacer"
import { RouteProvider, useRoute } from "../../src/context/route"
import { TuiAppProvider } from "../../src/context/runtime"
import { StorageProvider } from "../../src/context/storage"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { PromptFooter } from "../../src/feature-plugins/prompt/footer"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { createApi, createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { until } from "../fixture/wait"

// A fake service for CLIProxyPacer's screens: the `pacer.*` routes answered from plain data, as slowly as asked (a
// far CPP takes 300 ms), with every call logged, and the screens mounted under the providers they use.

export const CHAT = "ses_chat"
export const SUBAGENT = "ses_subagent"
export const OTHER = "ses_other"

/** 2026-11-06 14:02:00 on this machine's clock, so times print as 14:02 in any time zone. */
export const NOW = new Date(2026, 10, 6, 14, 2, 0).getTime()

export function status(state: PacerStatus["state"], extra: Partial<PacerStatus> = {}): PacerStatus {
  return { state, since: NOW - 3_600_000, asOf: NOW, refused: false, ...extra }
}

export function chat(extra: Partial<PacerChat> = {}): PacerChat {
  return {
    sessionID: CHAT,
    model: "claude-opus-4-5",
    provider: "claude",
    account: "max-2",
    warm: true,
    warmUntil: NOW + 5 * 60_000,
    coldAt: NOW + 23 * 60_000 + 41_000,
    pings: { active: true, left: 4, sent: 1, intervalMs: 270_000, failed: false },
    switches: { warming: true, compactBeforeCold: false, compactColdFirst: false },
    asOf: NOW,
    ...extra,
  }
}

export function accounts(extra: Partial<PacerAccounts["items"][number]> = {}): PacerAccounts {
  return {
    asOf: NOW,
    items: [
      {
        alias: "max-2",
        provider: "claude",
        plan: "max",
        windows: [
          {
            label: "5h",
            scope: "all",
            seconds: 18_000,
            left: 62,
            resetsAt: NOW + 80 * 60_000,
            readAt: NOW,
            state: "current",
            stale: false,
            staleAt: NOW + 3_600_000,
          },
          {
            label: "7d",
            scope: "all",
            seconds: 604_800,
            left: 80.4,
            resetsAt: NOW + (3 * 24 + 4) * 3_600_000,
            readAt: NOW,
            state: "estimated",
            stale: false,
            staleAt: NOW + 3_600_000,
          },
        ],
        ...extra,
      },
      { alias: "max-1", provider: "claude", windows: [] },
    ],
  }
}

/** Request `index` of a chat, newest first: one second older per index. */
export function request(index: number, extra: Partial<PacerRequest> = {}): PacerRequest {
  return {
    id: `req_${index}`,
    at: NOW - index * 1000,
    sessionID: CHAT,
    subagent: false,
    kind: "step",
    model: "claude-opus-4-5",
    provider: "claude",
    account: "max-2",
    status: 200,
    failed: false,
    tokens: { input: 1200, output: 300, reasoning: 0, cacheRead: 120_300, cacheWrite: 1200 },
    cost: 0.0123 as PacerRequest["cost"],
    verdict: "hit",
    miss: false,
    ...extra,
  }
}

/**
 * A call of CPP's web tools at `index` (one second older per index, as `request`), as the service shapes CPP's row of
 * it, `row` its number at CPP: kind 6, without a request ID (spec cliproxypacer-step-2, the decision of 2026-11-07).
 */
export function webCall(index: number, row: number): PacerRequest {
  const [cpp] = PacerWire.rows([
    {
      id: row,
      at: NOW - index * 1000,
      ext: "",
      kind: 6,
      provider: "exa",
      alias: "web_search",
      account: "exa-1",
      status: 200,
      cost_api: 5_000_000,
      session_ext: "0b6d1c52-5e0a-4f8e-9a51-2c4b7f1d9e30",
    },
  ])
  return PacerWire.request(cpp!, { sessionID: SessionID.make(CHAT) }, { offset: 0, now: NOW })
}

export function miss(index: number, extra: Partial<PacerRequest> = {}) {
  return request(index, {
    verdict: "miss",
    miss: true,
    cause: "prefix changed",
    changedPart: "system",
    rewritten: 98_100,
    missCost: 0.41 as PacerRequest["cost"],
    tokens: { input: 1200, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 98_100 },
    ...extra,
  })
}

/** The cache notice of request `index` (one second older per index, as `request`): a miss of `CHAT` by default. */
export function notice(index: number, extra: Partial<PacerNotice> = {}): PacerNotice {
  return {
    requestID: `req_${index}`,
    sessionID: CHAT,
    rootID: CHAT,
    title: "Fix the flaky test",
    agent: "build",
    model: "claude-opus-4-5",
    verdict: "miss",
    tokens: 152_340,
    cause: "prefix changed · system",
    missCost: 0.41 as PacerNotice["missCost"],
    at: NOW - index * 1000,
    ...extra,
  } as PacerNotice
}

export function promptChange(of: PacerRequest, extra: Partial<PacerPromptChange> = {}): PacerPromptChange {
  return {
    request: of,
    comparedWith: { id: "req_prev", at: of.at - 60_000 },
    kept: "all",
    items: [
      {
        path: "messages[0].content[0]",
        kind: "system",
        summary: "You are openforge",
        chars: 12_300,
        change: "changed",
        error: false,
      },
      { path: "messages[5]", kind: "prompt", summary: "fix the test", chars: 120, change: "new", error: false },
      { path: "tools[3]", kind: "tool", summary: "bash", chars: 800, change: "marker", error: false },
    ],
    removed: [],
    unchanged: 45,
    asOf: NOW,
    ...extra,
  }
}

/** The upstream prompt footer, under the location as the prompt draws it, with the TUI's own data. */
export function Toolbar(props: { sessionID?: string }) {
  const data = useData()
  const theme = useTheme()
  const context = {
    location: { directory },
    theme,
    data,
    keymap: { shortcuts: (id: string) => (id === "command.palette.show" ? ["ctrl+p"] : []), dispatch: () => {} },
    client: { rpc: () => ({ get: () => Promise.resolve(null), events: { on: () => () => {} } }) },
  } as unknown as Plugin.Context
  return (
    <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
      <box flexGrow={1} flexShrink={1} minWidth={0}>
        <text>~/project</text>
      </box>
      <PromptFooter context={context} sessionID={props.sessionID} mode="normal" showDetails={true} />
    </box>
  )
}

export interface Call {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly body?: unknown
  readonly at: number
  /** When its answer was sent. */
  done?: number
}

/** The `pacer.*` routes, answered from the fields below after `delay` ms. */
export function pacerFake(input: { delay?: number } = {}) {
  const fake = {
    delay: input.delay ?? 0,
    status: status("unset"),
    accounts: null as PacerAccounts | null,
    chats: {} as Record<string, PacerChat | null>,
    /** Each chat's requests, newest first. */
    requests: {} as Record<string, PacerRequest[]>,
    prompts: {} as Record<string, PacerPromptChange | null>,
    /** CLIProxyPacer's settings for all chats, as they apply at the key level (spec cliproxypacer-cold-ask, section 2). */
    settings: { compactColdFirst: false, compactBeforeCold: false } as PacerSettings,
    /** The cache notices the service holds, newest first; a dismissal drops one. */
    notices: [] as PacerNotice[],
    /** Requests, prompts, settings and updates answer 503, as when the pacer is not on. */
    unavailable: false,
    calls: [] as Call[],
    /** Calls to the pacer routes made after `since` (a `performance.now()`). */
    since: (since: number) => fake.calls.filter((call) => call.at >= since),
    async handle(url: URL, request: Request): Promise<Response | undefined> {
      if (!url.pathname.startsWith("/api/experimental/pacer/")) return undefined
      const call: Call = {
        method: request.method,
        path: url.pathname.slice("/api/experimental/pacer/".length),
        query: Object.fromEntries(url.searchParams),
        body: request.method === "PATCH" ? await request.json() : undefined,
        at: performance.now(),
      }
      fake.calls.push(call)
      if (fake.delay > 0) await Bun.sleep(fake.delay)
      call.done = performance.now()
      return answer(call)
    },
  }
  const refuse = () =>
    json(
      {
        _tag: "ServiceUnavailableError",
        message: "CLIProxyPacer can't answer: it is not on",
        service: "cliproxypacer",
      },
      { status: 503 },
    )
  const answer = (call: Call) => {
    const parts = call.path.split("/")
    if (call.path === "status") return json({ data: fake.status })
    if (call.path === "accounts") return json({ data: fake.accounts })
    if (call.path === "refresh" && call.method === "POST") return new Response(null, { status: 204 })
    if (parts[0] === "chat" && parts.length === 2 && call.method === "GET")
      return json({ data: fake.chats[parts[1]!] ?? null })
    if (parts[0] === "chat" && parts.length === 2 && call.method === "PATCH") {
      if (fake.unavailable) return refuse()
      const current = fake.chats[parts[1]!] ?? chat({ sessionID: parts[1]! })
      const change = call.body as { warming?: boolean; compactBeforeCold?: boolean; compactColdFirst?: boolean }
      const next = { ...current, switches: { ...current.switches, ...change } }
      fake.chats[parts[1]!] = next
      return json({ data: next })
    }
    if (call.path === "settings") {
      if (fake.unavailable) return refuse()
      if (call.method === "PATCH") fake.settings = { ...fake.settings, ...(call.body as Partial<PacerSettings>) }
      return json({ data: fake.settings })
    }
    if (parts[0] === "chat" && parts[2] === "requests") {
      if (fake.unavailable) return refuse()
      const all = fake.requests[parts[1]!] ?? []
      const list = call.query.filter === "misses" ? all.filter((item) => item.miss) : all
      const limit = Number(call.query.limit ?? 50)
      const start = call.query.cursor === undefined ? 0 : list.findIndex((item) => item.id === call.query.cursor) + 1
      const items = list.slice(start, start + limit)
      const cursor = start + limit < list.length ? items.at(-1)?.id : undefined
      return json({ data: { items, ...(cursor ? { cursor } : {}), asOf: NOW } })
    }
    if (parts[0] === "prompt") {
      if (fake.unavailable) return refuse()
      return json({ data: fake.prompts[decodeURIComponent(parts[1]!)] ?? null })
    }
    if (call.path === "notices" && call.method === "GET") return json({ data: fake.notices })
    if (parts[0] === "notices" && parts[2] === "dismiss" && call.method === "POST") {
      const requestID = decodeURIComponent(parts[1]!)
      fake.notices = fake.notices.filter((notice) => notice.requestID !== requestID)
      return json({ data: true })
    }
    throw new Error(`unexpected pacer call: ${call.method} ${call.path}`)
  }
  return fake
}

export type PacerFake = ReturnType<typeof pacerFake>

/** The TUI's config as an update writes it. */
type ConfigDraft = { -readonly [Key in keyof Config.Info]: Config.Info[Key] }

export function sessionInfo(id: string, providerID: string, parentID?: string, cost = 0) {
  return {
    id,
    projectID: "proj_test",
    title: id,
    agent: "build",
    model: { providerID, id: "claude-opus-4-5" },
    location: { directory },
    cost,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    ...(parentID ? { parentID } : {}),
  }
}

/** An assistant step of a chat. */
export function step(
  id: string,
  extra: { created: number; completed?: number; proxyRequestID?: string; providerID?: string; tokens?: number },
) {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: extra.providerID ?? "cliproxypacer", id: "claude-opus-4-5" },
    content: [],
    time: { created: extra.created, completed: extra.completed ?? extra.created + 500 },
    ...(extra.proxyRequestID ? { proxyRequestID: extra.proxyRequestID } : {}),
    ...(extra.tokens ? { tokens: { input: extra.tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } : {}),
  } as unknown as SessionMessageInfo
}

/**
 * Mounts `content` under the providers CPP's screens use, with `fake` answering the pacer routes, a session per
 * entry of `sessions` (`CHAT` on CPP by default) and the route at `route`. `clock` drives the countdown clock.
 */
export async function renderPacer(input: {
  fake: PacerFake
  content: (scope: { pacer: Pacer }) => JSX.Element
  sessions?: Record<
    string,
    {
      providerID: string
      parentID?: string
      /** No model selected for it, as for a chat on the default model; `providerID` is then its answers'. */
      unselected?: boolean
      messages?: SessionMessageInfo[]
      /** Messages before `messages`, on the next page of the history. */
      older?: SessionMessageInfo[]
      cost?: number
    }
  >
  route?: string
  width?: number
  height?: number
  keybinds?: Partial<TuiKeybind.Keybinds>
  /** The "new-designs" experiment on. */
  newDesigns?: boolean
  /** `"default"`: the store's own clock, as the app has it. */
  clock?: ManualClock | "default"
  /** The TUI's config, which Settings change in memory, as a config file would be. */
  config?: Omit<Config.Info, "keybinds">
}) {
  const state = await tmpdir()
  // One config for the first render and for what Settings write, so a write keeps the "new-designs" experiment.
  const initial: Config.Info = {
    ...input.config,
    keybinds: input.keybinds ?? {},
    ...(input.newDesigns ? { experimental: { ...input.config?.experimental, "new-designs": true } } : {}),
  }
  let tui: Config.Info = structuredClone(initial)
  const service = {
    get: async () => tui,
    update: async (mutate: (draft: ConfigDraft) => void) => {
      const next = structuredClone(tui)
      mutate(next)
      tui = next
      return next
    },
  }
  const events = createEventStream()
  const clock = input.clock === "default" ? undefined : (input.clock ?? new ManualClock())
  if (!input.clock) clock!.setTime(NOW)
  const sessions = input.sessions ?? { [CHAT]: { providerID: "cliproxypacer" } }
  const ready = Promise.withResolvers<void>()
  const calls = createFetch(async (url, request) => {
    const pacer = await input.fake.handle(url, request)
    if (pacer) return pacer
    const sessionID = url.pathname.match(/^\/api\/session\/([^/]+)$/)?.[1]
    const known = sessionID === undefined ? undefined : sessions[sessionID]
    if (sessionID && known) {
      const info = sessionInfo(sessionID, known.providerID, known.parentID, known.cost)
      const { model: _model, ...unselected } = info
      return json({ data: known.unselected ? unselected : info })
    }
    const messagesOf = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/)?.[1]
    if (messagesOf) {
      const known = sessions[messagesOf]
      if (url.searchParams.get("cursor") === "older")
        return json({ data: [...(known?.older ?? [])].reverse(), cursor: {} })
      return json({
        data: [...(known?.messages ?? [])].reverse(),
        cursor: known?.older?.length ? { next: "older" } : {},
      })
    }
    if (url.pathname === "/api/session" && url.searchParams.has("parentID")) return json({ data: [], cursor: {} })
  }, events)
  let pacer!: Pacer
  let route!: ReturnType<typeof useRoute>
  let theme!: ReturnType<typeof useTheme>
  let dispatch!: (command: string) => void
  let config!: ReturnType<typeof useConfig>
  let dialog!: ReturnType<typeof useDialog>

  function Probe() {
    const data = useData()
    pacer = usePacer()!
    route = useRoute()
    theme = useTheme()
    dispatch = Keymap.use().dispatch
    config = useConfig()
    dialog = useDialog()
    onMount(() => {
      void Promise.all(
        Object.keys(sessions).map((id) => Promise.all([data.session.sync(id), data.session.message.sync(id)])),
      ).then(() => ready.resolve(), ready.reject)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory} paths={{ state: state.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ConfigProvider config={createTuiResolvedConfig(initial)} service={service}>
              <Keymap.Provider>
                <ToastProvider>
                  <RouteProvider initialRoute={{ type: "session", sessionID: input.route ?? CHAT }}>
                    <ClientProvider api={createApi(calls.fetch)}>
                      <DataProvider directory={directory}>
                        <LocationProvider>
                          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                            <PacerProvider clock={clock}>
                              <DialogProvider>
                                <Probe />
                                {input.content({
                                  get pacer() {
                                    return pacer
                                  },
                                })}
                              </DialogProvider>
                            </PacerProvider>
                          </ThemeProvider>
                        </LocationProvider>
                      </DataProvider>
                    </ClientProvider>
                  </RouteProvider>
                </ToastProvider>
              </Keymap.Provider>
            </ConfigProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 100, height: input.height ?? 24, kittyKeyboard: true },
  )
  await ready.promise
  // The status read once the event stream is up.
  await until(() => input.fake.calls.some((call) => call.path === "status"), 5_000)
  return {
    app,
    events,
    /** Undefined with the store's own clock. */
    clock: clock as ManualClock,
    get pacer() {
      return pacer
    },
    get route() {
      return route
    },
    get theme() {
      return theme
    },
    dispatch: (command: string) => dispatch(command),
    /** The dialogs, to open one over the screen. */
    get dialog() {
      return dialog
    },
    /** The TUI's config as last written. */
    config: () => tui,
    /** Changes the TUI's config, as a Settings row does. */
    configure: (mutate: (draft: ConfigDraft) => void) => config.update(mutate),
    /** Where this TUI keeps its storage. */
    state: state.path,
    emit(event: { type: string; data: unknown }) {
      events.emit({ id: `evt_${Math.random()}`, created: NOW, ...event } as unknown as OpenCodeEvent)
    },
    /** Resolves with the frame once one matches; events and answers arrive on their own, so this polls. */
    async frame(match: (frame: string) => boolean, timeout = 5_000) {
      const deadline = Date.now() + timeout
      while (!match(app.captureCharFrame())) {
        if (Date.now() > deadline)
          throw new Error(`no frame matched within ${timeout} ms; the last:\n${app.captureCharFrame()}`)
        await Bun.sleep(2)
      }
      return app.captureCharFrame()
    },
    /** Resolves once every pacer call made so far is answered and the renderer drew what changed. */
    async settle() {
      await until(() => input.fake.calls.every((call) => call.done !== undefined), 5_000)
      await Bun.sleep(5)
      await app.renderOnce()
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await state[Symbol.asyncDispose]()
    },
  }
}

/** The colour of the first span whose text contains `text`. */
export function colorOf(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  return app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes(text))
    ?.fg.toInts()
}

/** How the first span holding the text is drawn: its colour, and whether it is dimmed. */
export function styleOf(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  const span = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes(text))
  return span && { fg: span.fg.toInts(), dim: (span.attributes & TextAttributes.DIM) !== 0 }
}
