/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { PacerRequest, SessionMessageInfo } from "@opencode/client"
import { TextAttributes, TextRenderable, type Renderable } from "@opentui/core"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useRoute } from "../../src/context/route"
import { usePacerSession } from "../../src/pacer/jump"
import { Composer } from "../../src/routes/session/composer"
import { recordFrames, type RecordedFrame } from "../fixture/frames"
import { until } from "../fixture/wait"
import {
  CHAT,
  chat,
  miss,
  NOW,
  OTHER,
  pacerFake,
  promptChange,
  renderPacer,
  request,
  status,
  step,
  styleOf,
  SUBAGENT,
  Toolbar,
  webCall,
} from "./fixture"

// Section 7 of spec cliproxypacer-step-1 and its Proof and Benchmarks: the Requests tab, what changed, no flicker.
// The fake service answers the pacer routes in 300 ms, as a CPP across the internet does; the tab must not wait on
// it. Every frame the renderer draws is recorded and checked, not only the last.

const FAR = 300
const KIND = /(\d\d:\d\d:\d\d) {2}(step|ping|title|compaction|explore|search)\b/

/** The times of the request rows a frame shows, top to bottom. */
function rowsOf(frame: string) {
  return frame.split("\n").flatMap((line) => line.match(KIND)?.[1] ?? [])
}

const time = (index: number) => {
  const date = new Date(NOW - index * 1000)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":")
}

/** The session route's part the tab needs: the composer under a transcript, the toolbar while it is closed. */
function Session(props: { sessionID: string; moves: string[] }) {
  const [composer, setComposer] = createStore({ open: false, tab: undefined as string | undefined })
  usePacerSession({
    sessionID: props.sessionID,
    ready: () => true,
    open: () => setComposer({ open: true, tab: "requests" }),
    jump: (messageID) => props.moves.push(`${props.sessionID} ${messageID}`),
    bottom: () => props.moves.push(`${props.sessionID} end`),
  })
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1}>
        <text>transcript of {props.sessionID}</text>
      </box>
      <Composer
        sessionID={props.sessionID}
        open={composer.open}
        defaultTab={composer.tab}
        onClose={() => setComposer("open", false)}
      />
      <Show when={!composer.open}>
        <Toolbar sessionID={props.sessionID} />
      </Show>
    </box>
  )
}

async function requestsTab(
  input: {
    requests?: PacerRequest[]
    state?: Parameters<typeof status>[0]
    delay?: number
    providerID?: string
    messages?: SessionMessageInfo[]
    older?: SessionMessageInfo[]
    prompts?: Record<string, ReturnType<typeof promptChange>>
    width?: number
    height?: number
    /** CPP is far from the start, the first pages too. */
    far?: boolean
  } = {},
) {
  const fake = pacerFake({ delay: input.far ? FAR : 0 })
  Object.assign(fake.prompts, input.prompts)
  fake.status = status(input.state ?? "on")
  fake.chats[CHAT] = chat()
  fake.chats[SUBAGENT] = chat({ sessionID: SUBAGENT })
  fake.requests[CHAT] = input.requests ?? Array.from({ length: 20 }, (_, index) => request(index))
  const moves: string[] = []
  const setup = await renderPacer({
    fake,
    width: input.width ?? 120,
    height: input.height ?? 30,
    sessions: {
      [CHAT]: { providerID: input.providerID ?? "cliproxypacer", messages: input.messages, older: input.older },
      [SUBAGENT]: {
        providerID: "cliproxypacer",
        parentID: CHAT,
        messages: [step("msg_sub", { created: NOW - 5_000, proxyRequestID: "req_sub" })],
      },
      // A chat on another provider: it has no Requests tab.
      [OTHER]: { providerID: "anthropic" },
    },
    content: () => {
      const route = useRoute()
      return (
        <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
          {(sessionID) => <Session sessionID={sessionID} moves={moves} />}
        </Show>
      )
    },
  })
  // The page of both filters is read when the chat is shown; only then is the far CPP slow.
  if ((input.state === undefined || input.state === "on") && (input.providerID === undefined || input.messages))
    await until(
      () => setup.pacer.page(CHAT, "all") !== undefined && setup.pacer.page(CHAT, "misses") !== undefined,
      5_000,
      "both first pages held",
    )
  fake.delay = input.delay ?? FAR
  return { ...setup, fake, moves }
}

type Setup = Awaited<ReturnType<typeof requestsTab>>

/** Opens the composer at the Requests tab with a click on the toolbar's cache item, as the spec's second way. */
async function clickCacheItem(setup: Setup) {
  const frame = await setup.frame((frame) => frame.includes("warm 23:41"))
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes("warm 23:41"))
  await setup.app.mockMouse.click(lines[row]!.indexOf("warm 23:41") + 2, row)
}

/** Every frame drawn is one of the finished `states`, and none went unread. */
function finished(
  recorder: { readonly frames: readonly RecordedFrame[]; readonly missed: number },
  states: ((frame: string) => boolean)[],
) {
  expect(recorder.missed).toBe(0)
  expect(recorder.frames.length).toBeGreaterThan(0)
  const unfinished = recorder.frames.filter((frame) => !states.some((state) => state(frame.text)))
  expect(unfinished.map((frame) => frame.text)).toEqual([])
}

const closed = (frame: string) => frame.includes("warm 23:41") && rowsOf(frame).length === 0
const list = (rows: string[]) => (frame: string) => rowsOf(frame).join(" ") === rows.join(" ")
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => time(from + index))

describe("opening the tab", () => {
  test("draws the held first page within 100 ms of the click, reading nothing, on every frame", async () => {
    await using setup = await requestsTab()
    using recorder = recordFrames(setup.app)
    const start = performance.now()
    await clickCacheItem(setup)
    const frame = await setup.frame((frame) => rowsOf(frame).length > 0)
    const drawn = recorder.frames.find((frame) => rowsOf(frame.text).length > 0)!
    console.log(
      `Requests tab: first page on screen ${(drawn.at - start).toFixed(1)} ms after the click (CPP at ${FAR} ms)`,
    )
    expect(drawn.at - start).toBeLessThan(100)
    expect(setup.fake.since(start)).toEqual([])
    expect(rowsOf(frame)).toEqual(range(0, 6))
    expect(frame).toContain("Requests")
    finished(recorder, [closed, list(range(0, 6))])
  })

  test("→ from the tab before it draws the held page within 100 ms of the key", async () => {
    await using setup = await requestsTab()
    // Down from the prompt opens the footer at Subagents; → → reaches Requests.
    setup.pacer.openRequests(CHAT)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    setup.app.mockInput.pressArrow("left")
    await setup.frame((frame) => rowsOf(frame).length === 0)
    using recorder = recordFrames(setup.app)
    const start = performance.now()
    setup.app.mockInput.pressArrow("right")
    await setup.frame((frame) => rowsOf(frame).length > 0)
    const drawn = recorder.frames.find((frame) => rowsOf(frame.text).length > 0)!
    console.log(`Requests tab: first page on screen ${(drawn.at - start).toFixed(1)} ms after → (CPP at ${FAR} ms)`)
    expect(drawn.at - start).toBeLessThan(100)
    expect(setup.fake.since(start)).toEqual([])
  })

  test("the tab comes after Terminals' place, last", async () => {
    await using setup = await requestsTab()
    await clickCacheItem(setup)
    const frame = await setup.frame((frame) => rowsOf(frame).length > 0)
    expect(frame).toMatch(/Subagents +Shell +Requests/)
  })
})

describe("the list", () => {
  test("Ctrl+A switches to the misses and back at once, from the held pages, on every frame", async () => {
    const requests = Array.from({ length: 20 }, (_, index) => (index % 4 === 1 ? miss(index) : request(index)))
    await using setup = await requestsTab({ requests })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    using recorder = recordFrames(setup.app)
    const start = performance.now()
    setup.app.mockInput.pressKey("a", { ctrl: true })
    const misses = [1, 5, 9, 13, 17].map(time)
    await setup.frame(list(misses))
    const drawn = recorder.frames.find((frame) => list(misses)(frame.text))!
    console.log(`Ctrl+A: misses on screen ${(drawn.at - start).toFixed(1)} ms after the key`)
    expect(drawn.at - start).toBeLessThan(100)
    setup.app.mockInput.pressKey("a", { ctrl: true })
    await setup.frame(list(range(0, 6)))
    // No page was read for either: the only reads are what changed, ahead, for the row under the cursor.
    expect(setup.fake.since(start).filter((call) => !call.path.startsWith("prompt/"))).toEqual([])
    finished(recorder, [list(range(0, 6)), list(misses)])
    expect(setup.app.captureCharFrame()).toContain("show misses")
  })

  test("scrolling to the end reads the next page; rows keep their place and height on every frame", async () => {
    await using setup = await requestsTab({ requests: Array.from({ length: 120 }, (_, index) => request(index)) })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    using recorder = recordFrames(setup.app)
    for (let index = 0; index < 45; index++) setup.app.mockInput.pressArrow("down")
    await setup.frame((frame) => rowsOf(frame).at(-1) === time(45))
    expect(setup.fake.calls.at(-1)).toMatchObject({
      path: `chat/${CHAT}/requests`,
      query: { filter: "all", cursor: "req_49" },
    })
    // The next page arrives while the list shows rows 40 to 45: nothing on screen moves.
    await until(() => setup.pacer.page(CHAT, "all")!.items.length === 100, 5_000, "the second page")
    for (let index = 0; index < 10; index++) setup.app.mockInput.pressArrow("down")
    await setup.frame((frame) => rowsOf(frame).at(-1) === time(55))
    // Every frame shows six consecutive rows.
    expect(recorder.missed).toBe(0)
    const windows = recorder.frames.map((frame) => rowsOf(frame.text))
    for (const rows of windows) {
      expect(rows).toHaveLength(6)
      const first = range(0, 120).indexOf(rows[0]!)
      expect(rows).toEqual(range(first, first + 6))
    }
  })

  test("a new request adds its row at the top without moving the selection, and the list read again keeps its rows", async () => {
    await using setup = await requestsTab({ delay: FAR })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    setup.app.mockInput.pressArrow("down")
    setup.app.mockInput.pressArrow("down")
    await setup.frame(() => selectedTime(setup) === time(2))
    using recorder = recordFrames(setup.app)
    // A new request at CPP: the notice comes, the page is read again in 300 ms.
    setup.fake.requests[CHAT] = [request(-1), ...setup.fake.requests[CHAT]!]
    const start = performance.now()
    setup.emit({ type: "pacer.requests.updated", data: { sessionID: CHAT } })
    await setup.frame((frame) => rowsOf(frame)[0] === time(-1))
    const swapped = recorder.frames.find((frame) => rowsOf(frame.text)[0] === time(-1))!
    // The old rows stayed on screen through the read.
    expect(swapped.at - start).toBeGreaterThanOrEqual(FAR - 5)
    finished(recorder, [list(range(0, 6)), list(range(-1, 5))])
    // The selection holds its request on every frame.
    for (const frame of recorder.frames) expect(selected(frame)).toBe(time(2))
  })

  test("the columns hold while rows arrive; one with a longer value is cut until the tab opens again or the window resizes", async () => {
    await using setup = await requestsTab({ delay: 20, width: 100 })
    await clickCacheItem(setup)
    const before = await setup.frame((frame) => rowsOf(frame).length > 0)
    const header = (frame: string) => frame.split("\n").find((line) => /time +kind/.test(line))
    const line = (frame: string, at: string) => frame.split("\n").find((text) => text.includes(at))
    const longer = { model: "claude-sonnet-4-5-20250929", account: "claude-apikey-2" }
    {
      using recorder = recordFrames(setup.app)
      setup.fake.requests[CHAT] = [request(-1, longer), ...setup.fake.requests[CHAT]!]
      setup.emit({ type: "pacer.requests.updated", data: { sessionID: CHAT } })
      await setup.frame((frame) => rowsOf(frame)[0] === time(-1))
      await setup.settle()
      expect(recorder.missed).toBe(0)
      // On every frame the header and the rows held before stay where they were, cell for cell.
      for (const frame of recorder.frames) {
        expect(header(frame.text)).toBe(header(before)!)
        for (const at of range(0, 5)) expect(line(frame.text, at)).toBe(line(before, at)!)
      }
    }
    const cut = line(setup.app.captureCharFrame(), time(-1))!
    expect(cut).toContain("claude-sonnet-…")
    expect(cut).not.toContain(longer.account)
    // Opened again, the columns fit it.
    setup.app.mockInput.pressArrow("up")
    await setup.frame((frame) => rowsOf(frame).length === 0)
    await clickCacheItem(setup)
    const again = await setup.frame((frame) => rowsOf(frame).length > 0)
    expect(line(again, time(-1))).toContain(longer.model)
    expect(line(again, time(-1))).toContain(longer.account)
    expect(header(again)).not.toBe(header(before))
    // A narrower window sizes them again, to its width.
    setup.app.resize(80, 30)
    const narrow = await setup.frame((frame) => rowsOf(frame).length > 0 && !frame.includes(longer.model))
    expect(header(narrow)).toMatch(/time +kind +account +read\/write +verdict +cost/)
    expect(line(narrow, time(-1))).toContain(longer.account)
  })

  test("opened with no rows yet, the columns are sized to the first rows that arrive", async () => {
    await using setup = await requestsTab({ requests: [], delay: 20, width: 100 })
    await clickCacheItem(setup)
    await setup.frame((frame) => frame.includes("No requests yet"))
    setup.fake.requests[CHAT] = [request(0, { model: "claude-sonnet-4-5-20250929", account: "claude-apikey-2" })]
    setup.emit({ type: "pacer.requests.updated", data: { sessionID: CHAT } })
    const frame = await setup.frame((frame) => rowsOf(frame).length === 1)
    expect(frame).toContain("claude-sonnet-4-5-20250929  claude-apikey-2")
  })

  test("a call of CPP's web tools is a row of the chat, as search (spec cliproxypacer-step-2, section 4)", async () => {
    const search = request(0, {
      kind: "search",
      model: "web_search",
      provider: "exa",
      account: "exa-1",
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.005 as PacerRequest["cost"],
      verdict: undefined,
    })
    await using setup = await requestsTab({
      requests: [search, ...Array.from({ length: 5 }, (_, index) => request(index + 1))],
      width: 100,
    })
    await clickCacheItem(setup)
    const frame = await setup.frame((frame) => rowsOf(frame).length === 6)
    const row = frame.split("\n").find((line) => line.includes(time(0)))!
    expect(row).toMatch(new RegExp(`${time(0)} {2}search +web_search +exa-1 +0/0 +\\$0\\.005`))
  })

  test("watched from the newest row, new requests come in under the cursor on the top line, past the six rows", async () => {
    // Found live: a cursor left on the newest row was pushed down by each new request until the view followed it
    // off the top, and the newest requests stopped showing.
    await using setup = await requestsTab({ delay: 20 })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0 && selectedTime(setup) === time(0))
    {
      // Spans are read from the recorded frames only: reading them while the renderer draws one fails.
      using recorder = recordFrames(setup.app)
      for (const index of [-1, -2, -3, -4, -5, -6, -7]) {
        setup.fake.requests[CHAT] = [request(index), ...setup.fake.requests[CHAT]!]
        setup.emit({ type: "pacer.requests.updated", data: { sessionID: CHAT } })
        await setup.frame((frame) => rowsOf(frame)[0] === time(index))
      }
      await setup.settle()
      // On every frame the six rows are the newest and the selection is the top one.
      finished(
        recorder,
        [-1, -2, -3, -4, -5, -6, -7].map((index) => list(range(index, index + 6))),
      )
      for (const frame of recorder.frames) expect(selected(frame)).toBe(rowsOf(frame.text)[0])
    }
    expect(rowsOf(setup.app.captureCharFrame())).toEqual(range(-7, -1))
    await setup.frame(() => selectedTime(setup) === time(-7))
    // Moved off the newest row, the selection holds its request.
    setup.app.mockInput.pressArrow("down")
    await setup.frame(() => selectedTime(setup) === time(-6))
    setup.fake.requests[CHAT] = [request(-8), ...setup.fake.requests[CHAT]!]
    setup.emit({ type: "pacer.requests.updated", data: { sessionID: CHAT } })
    await setup.frame((frame) => rowsOf(frame)[0] === time(-8))
    await setup.settle()
    await setup.frame(() => selectedTime(setup) === time(-6))
    // Back on the newest row, what changed and Esc come back to that row, not to one that came meanwhile.
    setup.app.mockInput.pressArrow("up")
    setup.app.mockInput.pressArrow("up")
    await setup.frame(() => selectedTime(setup) === time(-8))
    setup.app.mockInput.pressEnter({ ctrl: true })
    await setup.frame((frame) => frame.includes("CPP has no record of this request"))
    setup.fake.requests[CHAT] = [request(-9), ...setup.fake.requests[CHAT]!]
    setup.emit({ type: "pacer.requests.updated", data: { sessionID: CHAT } })
    await until(() => setup.pacer.page(CHAT, "all")!.items[0]!.id === "req_-9", 5_000)
    setup.app.mockInput.pressEscape()
    await setup.frame((frame) => rowsOf(frame)[0] === time(-9))
    await setup.settle()
    await setup.frame(() => selectedTime(setup) === time(-8))
  })

  test("back from what changed on the newest row, new requests come in under the cursor again", async () => {
    // Found live (round 5): after Ctrl+Enter and Esc on the newest row, the next request pushed the cursor down, as
    // what changed holds the row it was opened on.
    await using setup = await requestsTab({ delay: 20 })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0 && selectedTime(setup) === time(0))
    setup.app.mockInput.pressEnter({ ctrl: true })
    await setup.frame((frame) => frame.includes("CPP has no record of this request"))
    setup.app.mockInput.pressEscape()
    await setup.frame((frame) => rowsOf(frame).length > 0 && selectedTime(setup) === time(0))
    using recorder = recordFrames(setup.app)
    setup.fake.requests[CHAT] = [request(-1), ...setup.fake.requests[CHAT]!]
    setup.emit({ type: "pacer.requests.updated", data: { sessionID: CHAT } })
    await setup.frame((frame) => rowsOf(frame)[0] === time(-1))
    await setup.settle()
    finished(recorder, [list(range(0, 6)), list(range(-1, 5))])
    for (const frame of recorder.frames) expect(selected(frame)).toBe(rowsOf(frame.text)[0])
  })
})

describe("what changed", () => {
  const requests = [request(0), miss(1), request(2), request(3)]

  test("Ctrl+Enter on a held miss shows it in place of the list within 100 ms; Esc goes back on the same row", async () => {
    await using setup = await requestsTab({ requests, prompts: { req_1: promptChange(miss(1)) } })
    // The miss in the held page was read ahead.
    await until(() => setup.pacer.held("req_1") !== undefined, 5_000, "what changed read ahead")
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    setup.app.mockInput.pressArrow("down")
    await setup.frame(() => selectedTime(setup) === time(1))
    using recorder = recordFrames(setup.app)
    const start = performance.now()
    setup.app.mockInput.pressEnter({ ctrl: true })
    const detail = await setup.frame((frame) => frame.includes("compared with req_prev"))
    const drawn = recorder.frames.find((frame) => frame.text.includes("compared with req_prev"))!
    console.log(`What changed: on screen ${(drawn.at - start).toFixed(1)} ms after Ctrl+Enter (CPP at ${FAR} ms)`)
    expect(drawn.at - start).toBeLessThan(100)
    expect(setup.fake.since(start)).toEqual([])
    expect(detail).toContain("miss · prefix changed · system changed")
    expect(detail).toContain("98.1K tokens written again · the miss cost $0.41")
    expect(detail).toContain("changed  system     messages[0].content[0]  12.3K chars  You are openforge")
    expect(detail).toContain("45 unchanged")
    expect(rowsOf(detail)).toEqual([])
    setup.app.mockInput.pressEscape()
    await setup.frame((frame) => rowsOf(frame).length > 0)
    expect(selectedTime(setup)).toBe(time(1))
    // The same key goes there and back too.
    setup.app.mockInput.pressEnter({ meta: true })
    await setup.frame((frame) => frame.includes("compared with req_prev"))
    setup.app.mockInput.pressEnter({ meta: true })
    await setup.frame((frame) => rowsOf(frame).length > 0)
    expect(selectedTime(setup)).toBe(time(1))
    const isDetail = (frame: string) => frame.includes("compared with req_prev") && frame.includes("45 unchanged")
    finished(recorder, [list(range(0, 4)), isDetail])
  })

  test("Ctrl+Enter on a row not held keeps the list until it is, then shows it in one frame", async () => {
    // Row 2, a hit, isn't read ahead before the cursor reaches it.
    await using setup = await requestsTab({
      requests,
      prompts: { req_2: promptChange(request(2), { comparedWith: undefined }) },
    })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    using recorder = recordFrames(setup.app)
    setup.app.mockInput.pressArrow("down")
    setup.app.mockInput.pressArrow("down")
    const start = performance.now()
    setup.app.mockInput.pressEnter({ ctrl: true })
    await setup.frame((frame) => frame.includes("compared with no earlier request"))
    const drawn = recorder.frames.find((frame) => frame.text.includes("compared with no earlier request"))!
    expect(drawn.at - start).toBeGreaterThanOrEqual(FAR - 5)
    finished(recorder, [list(range(0, 4)), (frame) => frame.includes("compared with no earlier request")])
    expect(setup.fake.calls.filter((call) => call.path === "prompt/req_2")).toHaveLength(1)
  })

  test("opening the tab and Ctrl+Enter at once draws what changed for the newest row within 100 ms, CPP at 300 ms from the start", async () => {
    // Found live: the first Ctrl+Enter on the newest row, a hit, waited for its read: only misses were read ahead,
    // and the tab opens on the newest row.
    const many = [request(0), ...Array.from({ length: 9 }, (_, index) => miss(index + 1))]
    await using setup = await requestsTab({ requests: many, far: true, prompts: { req_0: promptChange(request(0)) } })
    // Read with the first pages, at once: not behind the misses read ahead, three at a time.
    await until(() => setup.pacer.held("req_0") !== undefined, FAR + 200, "the newest row read ahead")
    using recorder = recordFrames(setup.app)
    const start = performance.now()
    await clickCacheItem(setup)
    setup.app.mockInput.pressEnter({ ctrl: true })
    const detail = await setup.frame((frame) => frame.includes("compared with req_prev"))
    const drawn = recorder.frames.find((frame) => frame.text.includes("compared with req_prev"))!
    console.log(
      `What changed: on screen ${(drawn.at - start).toFixed(1)} ms after the click and Ctrl+Enter (CPP at ${FAR} ms)`,
    )
    expect(drawn.at - start).toBeLessThan(100)
    expect(setup.fake.since(start)).toEqual([])
    expect(detail).toContain("hit")
    expect(detail).toContain("45 unchanged")
    finished(recorder, [closed, list(range(0, 6)), (frame) => frame.includes("compared with req_prev")])
  })

  test("read ahead before CPP stored its prompt, the newest row isn't held as not kept: Ctrl+Enter reads it again", async () => {
    // CPP may store a prompt just after its request's row, and the newest row is read ahead as soon as it is listed.
    await using setup = await requestsTab({
      requests,
      delay: 0,
      prompts: { req_0: promptChange(request(0), { kept: "none", items: [] }) },
    })
    const reads = () => setup.fake.calls.filter((call) => call.path === "prompt/req_0")
    await until(() => reads().some((call) => call.done !== undefined), 5_000, "the newest row read ahead")
    await setup.settle()
    expect(setup.pacer.held("req_0")).toBeUndefined()
    setup.fake.prompts.req_0 = promptChange(request(0))
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    // The cursor coming back to it doesn't read it again: only asking does.
    setup.app.mockInput.pressArrow("down")
    setup.app.mockInput.pressArrow("up")
    await setup.settle()
    expect(reads()).toHaveLength(1)
    setup.app.mockInput.pressEnter({ ctrl: true })
    const frame = await setup.frame((frame) => frame.includes("compared with req_prev"))
    expect(frame).toContain("45 unchanged")
    expect(frame).not.toContain("prompt no longer kept")
    expect(reads()).toHaveLength(2)
  })

  test("Ctrl+Enter while the newest row is read ahead waits for that read, and shows its answer whatever it is", async () => {
    await using setup = await requestsTab({
      requests,
      far: true,
      prompts: { req_0: promptChange(request(0), { kept: "none", items: [] }) },
    })
    const reads = () => setup.fake.calls.filter((call) => call.path === "prompt/req_0")
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    expect(reads().map((call) => call.done)).toEqual([undefined])
    setup.app.mockInput.pressEnter({ ctrl: true })
    const frame = await setup.frame((frame) => frame.includes("prompt no longer kept"))
    expect(frame).toContain("compared with req_prev")
    expect(reads()).toHaveLength(1)
  })

  test("prompt no longer kept", async () => {
    await using setup = await requestsTab({
      requests,
      delay: 0,
      prompts: { req_1: promptChange(miss(1), { kept: "none", items: [] }) },
    })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    setup.app.mockInput.pressArrow("down")
    setup.app.mockInput.pressEnter({ ctrl: true })
    const frame = await setup.frame((frame) => frame.includes("prompt no longer kept"))
    expect(frame).toContain("compared with req_prev")
  })

  test("the items scroll, and the footer grows to at most half the window", async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      path: `messages[${index}]`,
      kind: "result",
      summary: `item ${index}`,
      chars: 10,
      change: "new" as const,
      error: false,
    }))
    await using setup = await requestsTab({
      requests,
      delay: 0,
      height: 30,
      prompts: { req_1: promptChange(miss(1), { items }) },
    })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    setup.app.mockInput.pressArrow("down")
    setup.app.mockInput.pressEnter({ ctrl: true })
    const frame = await setup.frame((frame) => frame.includes("item 0"))
    // Half of 30 rows: the composer, its tab bar and hints included, takes at most 15.
    const composer = frame.split("\n").filter((line) => line.includes("┃"))
    expect(composer.length).toBeLessThanOrEqual(15)
    expect(frame).not.toContain("item 20")
    for (let index = 0; index < 40; index++) setup.app.mockInput.pressArrow("down")
    const end = await setup.frame((frame) => frame.includes("45 unchanged"))
    expect(end).toContain("item 39")
    expect(end).not.toContain("item 0 ")
  })
})

// Spec cliproxypacer-cache-notices, section 3: a cache notice opens its chat's Requests tab on its request, showing
// what changed, from outside the tab.
describe("a request asked for from outside the tab", () => {
  const requests = [request(0), request(1), request(2), miss(3), request(4), request(5), request(6), request(7)]

  test("the closed composer opens at the tab, on the request's row, with what changed within 100 ms", async () => {
    await using setup = await requestsTab({ requests, prompts: { req_3: promptChange(miss(3)) } })
    await until(() => setup.pacer.held("req_3") !== undefined, 5_000, "what changed read ahead")
    await setup.frame(closed)
    using recorder = recordFrames(setup.app)
    const start = performance.now()
    setup.pacer.showRequest({ sessionID: CHAT, requestID: "req_3" })
    const detail = await setup.frame((frame) => frame.includes("compared with req_prev"))
    const drawn = recorder.frames.find((frame) => frame.text.includes("compared with req_prev"))!
    console.log(`A request asked for: what changed on screen ${(drawn.at - start).toFixed(1)} ms after`)
    expect(drawn.at - start).toBeLessThan(100)
    expect(detail).toContain("miss · prefix changed · system changed")
    expect(setup.fake.since(start)).toEqual([])
    expect(setup.pacer.reveal()).toBeUndefined()
    // Back, the cursor is on its row, not on the newest.
    setup.app.mockInput.pressEscape()
    await setup.frame((frame) => rowsOf(frame).length > 0)
    expect(selectedTime(setup)).toBe(time(3))
    finished(recorder, [closed, (frame) => frame.includes("compared with req_prev"), list(range(0, 6))])
  })

  test("the composer open at another tab comes to Requests; what changed not held is read", async () => {
    await using setup = await requestsTab({ requests, delay: 0, prompts: { req_6: promptChange(request(6)) } })
    setup.pacer.openRequests(CHAT)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    // ← to Subagents; the composer's own choice of tab stays Requests.
    setup.app.mockInput.pressArrow("left")
    await setup.frame((frame) => rowsOf(frame).length === 0 && !frame.includes("warm 23:41"))
    setup.pacer.showRequest({ sessionID: CHAT, requestID: "req_6" })
    await setup.frame((frame) => frame.includes("compared with req_prev") && frame.includes("hit"))
    setup.app.mockInput.pressEscape()
    await setup.frame(() => selectedTime(setup) === time(6))
  })

  test("a request of a chat not shown waits for it; one whose chat is left before its tab showed is dropped", async () => {
    await using setup = await requestsTab({ requests, delay: 0, prompts: { req_3: promptChange(miss(3)) } })
    await setup.frame(closed)
    setup.fake.prompts.req_sub = promptChange(miss(9, { id: "req_sub", sessionID: SUBAGENT }))
    setup.pacer.showRequest({ sessionID: SUBAGENT, requestID: "req_sub" })
    await Bun.sleep(30)
    expect(rowsOf(setup.app.captureCharFrame())).toEqual([])
    expect(setup.pacer.reveal()).toEqual({ sessionID: SUBAGENT, requestID: "req_sub" })
    // Shown, its tab opens on it.
    setup.route.navigate({ type: "session", sessionID: SUBAGENT })
    await setup.frame(
      (frame) => frame.includes("transcript of ses_subagent") && frame.includes("compared with req_prev"),
    )
    // Asked for in the chat shown while its tab can't show there (the chat isn't on CPP), then left: dropped.
    setup.route.navigate({ type: "session", sessionID: CHAT })
    await setup.frame((frame) => frame.includes("transcript of ses_chat"))
    setup.pacer.showRequest({ sessionID: OTHER, requestID: "req_other" })
    setup.route.navigate({ type: "session", sessionID: OTHER })
    await setup.frame((frame) => frame.includes("transcript of ses_other"))
    setup.route.navigate({ type: "session", sessionID: CHAT })
    await setup.frame((frame) => frame.includes("transcript of ses_chat"))
    expect(setup.pacer.reveal()).toBeUndefined()
  })
})

describe("CPP going away and coming back", () => {
  test("the same rows, greyed, as of 14:02; back, the rows read again replace them in one frame", async () => {
    await using setup = await requestsTab()
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    using recorder = recordFrames(setup.app)
    setup.emit({ type: "pacer.status", data: { status: status("unreachable", { asOf: NOW }) } })
    const greyed = await setup.frame((frame) => frame.includes("CPP unreachable · as of 14:02"))
    expect(rowsOf(greyed)).toEqual(range(0, 6))
    expect(styleOf(setup.app, time(3))).toEqual({ fg: setup.theme.text.faint.toInts(), dim: true })
    // Back: a new request came meanwhile; the page is read again in 300 ms, and swapped in one frame.
    setup.fake.requests[CHAT] = [request(-1), ...setup.fake.requests[CHAT]!]
    setup.emit({ type: "pacer.status", data: { status: status("on", { since: NOW + 60_000 }) } })
    await setup.frame((frame) => rowsOf(frame)[0] === time(-1))
    expect(setup.app.captureCharFrame()).not.toContain("CPP unreachable")
    expect(styleOf(setup.app, time(3))).toEqual({ fg: setup.theme.text.base.toInts(), dim: false })
    const notice = (frame: string) => frame.includes("CPP unreachable · as of 14:02")
    finished(recorder, [
      (frame) => list(range(0, 6))(frame) && !notice(frame),
      (frame) => list(range(0, 6))(frame) && notice(frame),
      (frame) => list(range(-1, 5))(frame) && !notice(frame),
    ])
    // Greyed rows are never drawn without the notice, nor the notice over current rows.
    for (const frame of recorder.frames) {
      const grey = frame.lines.some((line) =>
        line.spans.some(
          (span) =>
            span.text.includes(time(3)) &&
            span.fg.equals(setup.theme.text.faint) &&
            (span.attributes & TextAttributes.DIM) !== 0,
        ),
      )
      expect(grey).toBe(notice(frame.text))
    }
  })
})

describe("empty and hidden", () => {
  test("No requests yet, and No cache misses yet", async () => {
    await using setup = await requestsTab({ requests: [] })
    await clickCacheItem(setup)
    await setup.frame((frame) => frame.includes("No requests yet"))
    setup.app.mockInput.pressKey("a", { ctrl: true })
    await setup.frame((frame) => frame.includes("No cache misses yet"))
  })

  test("this proxy has no pacer", async () => {
    await using setup = await requestsTab({ state: "no-pacer" })
    setup.pacer.openRequests(CHAT)
    await setup.frame((frame) => frame.includes("This proxy has no pacer, so it keeps no request records"))
  })

  test("unreachable with nothing held", async () => {
    await using setup = await requestsTab({ state: "unreachable" })
    setup.pacer.openRequests(CHAT)
    const frame = await setup.frame((frame) => frame.includes("CPP unreachable · as of 14:02"))
    expect(rowsOf(frame)).toEqual([])
  })

  test("hidden when no CPP is set up or the chat never used it; nothing read, ticked or drawn", async () => {
    for (const input of [{ state: "unset" as const }, { providerID: "anthropic" }]) {
      await using setup = await requestsTab(input)
      await setup.settle()
      setup.app.mockInput.pressKey("x", { ctrl: true })
      setup.pacer.openRequests(CHAT)
      await setup.app.renderOnce()
      expect(setup.app.captureCharFrame()).not.toContain("Requests")
      expect(setup.app.captureCharFrame()).not.toContain("warm")
      // The accounts and the cache notices (spec cliproxypacer-cache-notices) are the service's, not the chat's: they
      // are read once CPP is set up, whatever chat shows.
      expect(setup.fake.calls.filter((call) => !["status", "accounts", "notices"].includes(call.path))).toEqual([])
      if (input.state === "unset") expect(setup.fake.calls.map((call) => call.path)).toEqual(["status"])
      expect(setup.pacer.ticking()).toBe(false)
      expect(setup.clock.pendingTimerCount).toBe(0)
    }
  })

  test("a chat that used CPP on an earlier step shows the tab, not the cache item: its model is another's", async () => {
    await using setup = await requestsTab({
      providerID: "anthropic",
      messages: [step("msg_1", { created: NOW - 9_000, proxyRequestID: "req_9", providerID: "cliproxypacer" })],
    })
    await until(() => setup.pacer.page(CHAT, "all") !== undefined, 5_000, "the chat's page")
    await setup.settle()
    expect(setup.app.captureCharFrame()).not.toContain("warm")
    setup.pacer.openRequests(CHAT)
    await setup.frame((frame) => rowsOf(frame).length > 0)
  })
})

describe("Enter moves the chat to where the request ended", () => {
  const messages = [
    step("msg_1", { created: NOW - 50_000, completed: NOW - 45_000, proxyRequestID: "req_50" }),
    step("msg_2", { created: NOW - 12_000, completed: NOW - 11_000, proxyRequestID: "req_12" }),
    step("msg_3", { created: NOW - 2_000, completed: NOW - 1_000, proxyRequestID: "req_2" }),
  ]

  test("its step's message, a ping's reply before it, an unnamed request's next step, a subagent's chat", async () => {
    const requests = [
      request(2),
      request(8, { kind: "ping" }),
      request(11, { id: "req_retried", failed: true, status: 502, verdict: undefined }),
      request(12),
      request(20, { id: "req_sub", subagent: true, sessionID: SUBAGENT, agent: "explore" }),
    ]
    await using setup = await requestsTab({ requests, messages })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    const press = async (moves: number) => {
      setup.app.mockInput.pressEnter()
      await until(() => setup.moves.length === moves, 5_000, `move ${moves}`)
    }
    await press(1)
    setup.app.mockInput.pressArrow("down")
    await press(2)
    setup.app.mockInput.pressArrow("down")
    await press(3)
    setup.app.mockInput.pressArrow("down")
    await press(4)
    expect(setup.moves).toEqual([`${CHAT} msg_3`, `${CHAT} msg_2`, `${CHAT} msg_3`, `${CHAT} msg_2`])
    // A subagent's request opens the subagent's chat, at its step.
    setup.app.mockInput.pressArrow("down")
    await press(5)
    expect(setup.route.data).toMatchObject({ type: "session", sessionID: SUBAGENT })
    expect(setup.moves.at(-1)).toBe(`${SUBAGENT} msg_sub`)
  })

  test("a request older than the messages held loads the history back to it", async () => {
    await using setup = await requestsTab({
      requests: [request(50)],
      messages: [step("msg_3", { created: NOW - 2_000, proxyRequestID: "req_2" })],
      older: [step("msg_1", { created: NOW - 50_000, proxyRequestID: "req_50" })],
      delay: 0,
    })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length > 0)
    setup.app.mockInput.pressEnter()
    await until(() => setup.moves.length === 1, 5_000, "the move")
    expect(setup.moves).toEqual([`${CHAT} msg_1`])
  })
})

// Spec cliproxypacer-step-2, section 4 and the decision of 2026-11-07: CPP records a call of its web tools without a
// request ID, so each goes by its row; it sent no prompt. The rows are shaped by the service's own code from CPP's.
describe("a web tool call's row", () => {
  const NO_PROMPT = "A web tool call sends no prompt, so there is nothing to compare"

  test("every call is its own row, on the first page and the next, and the list read again keeps them all", async () => {
    const calls = new Set([1, 2, 4, 50, 51, 53])
    const requests = Array.from({ length: 56 }, (_, index) =>
      calls.has(index) ? webCall(index, 1_000 - index) : request(index),
    )
    await using setup = await requestsTab({ requests, delay: 0 })
    const ids = () => setup.pacer.page(CHAT, "all")!.items.map((item) => item.id)
    await clickCacheItem(setup)
    const first = await setup.frame((frame) => rowsOf(frame).length === 6)
    expect(rowsOf(first)).toEqual(range(0, 6))
    expect(first.split("\n").filter((line) => / {2}search +web_search +exa-1 /.test(line))).toHaveLength(3)
    // Down near the end: the next page is read, and each call on it is added too.
    for (let index = 0; index < 45; index++) setup.app.mockInput.pressArrow("down")
    await until(() => setup.pacer.page(CHAT, "all")!.cursor === undefined, 5_000, "the next page")
    expect(ids()).toEqual(requests.map((item) => item.id))
    expect(new Set(ids()).size).toBe(56)
    for (let index = 0; index < 10; index++) setup.app.mockInput.pressArrow("down")
    const end = await setup.frame((frame) => rowsOf(frame).at(-1) === time(55))
    expect(rowsOf(end)).toEqual(range(50, 56))
    // A new request: the first page is read again, and the rows held beyond it stay, every call among them.
    setup.fake.requests[CHAT] = [request(-1), ...requests]
    setup.emit({ type: "pacer.requests.updated", data: { sessionID: CHAT } })
    await until(() => ids()[0] === "req_-1", 5_000, "the list read again")
    expect(ids()).toEqual(["req_-1", ...requests.map((item) => item.id)])
  })

  test("the cursor on a call selects that call alone, on every frame", async () => {
    const requests = [webCall(0, 300), webCall(1, 299), webCall(2, 298), request(3), request(4)]
    await using setup = await requestsTab({ requests, delay: 0 })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length === 5 && selectedTime(setup) === time(0))
    using recorder = recordFrames(setup.app)
    const keys = [
      ["down", 1],
      ["down", 2],
      ["down", 3],
      ["up", 2],
      ["up", 1],
      ["up", 0],
    ] as const
    for (const [key, index] of keys) {
      setup.app.mockInput.pressArrow(key)
      await setup.frame(() => selectedTime(setup) === time(index))
    }
    expect(recorder.missed).toBe(0)
    expect(recorder.frames.length).toBeGreaterThan(0)
    for (const frame of recorder.frames) expect(selectedLines(frame)).toHaveLength(1)
  })

  test("nothing is read for a call, ahead or on Ctrl+Enter or Alt+Enter, which says it sends no prompt", async () => {
    // The newest row, a call, is where the tab opens: a step's would be read with the first page.
    const requests = [webCall(0, 300), webCall(1, 299), request(2), miss(3)]
    await using setup = await requestsTab({ requests, delay: 0, prompts: { req_3: promptChange(miss(3)) } })
    // The miss is read ahead, as any.
    await until(() => setup.pacer.held("req_3") !== undefined, 5_000, "the miss read ahead")
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length === 4)
    setup.app.mockInput.pressArrow("down")
    await setup.frame(() => selectedTime(setup) === time(1))
    await setup.settle()
    using recorder = recordFrames(setup.app)
    const start = performance.now()
    setup.app.mockInput.pressEnter({ ctrl: true })
    const detail = await setup.frame((frame) => frame.includes(NO_PROMPT))
    const drawn = recorder.frames.find((frame) => frame.text.includes(NO_PROMPT))!
    expect(drawn.at - start).toBeLessThan(100)
    // In what changed's place and look: the list gone, the line muted, Esc to go back.
    expect(rowsOf(detail)).toEqual([])
    expect(styleOf(setup.app, NO_PROMPT)).toEqual({ fg: setup.theme.text.muted.toInts(), dim: false })
    expect(detail).toMatch(/back +esc/)
    setup.app.mockInput.pressEscape()
    await setup.frame((frame) => rowsOf(frame).length === 4)
    expect(selectedTime(setup)).toBe(time(1))
    // Alt+Enter on the newest, there and back.
    setup.app.mockInput.pressArrow("up")
    await setup.frame(() => selectedTime(setup) === time(0))
    setup.app.mockInput.pressEnter({ meta: true })
    await setup.frame((frame) => frame.includes(NO_PROMPT))
    setup.app.mockInput.pressEnter({ meta: true })
    await setup.frame((frame) => rowsOf(frame).length === 4)
    await setup.settle()
    // The one read of what changed is the miss's.
    expect(setup.fake.calls.filter((call) => call.path.startsWith("prompt/")).map((call) => call.path)).toEqual([
      "prompt/req_3",
    ])
    finished(recorder, [list(range(0, 4)), (frame) => frame.includes(NO_PROMPT) && rowsOf(frame).length === 0])
  })

  test("Enter on a call moves the chat to its first step that started after it, as for any request no message names", async () => {
    const messages = [
      step("msg_1", { created: NOW - 50_000, completed: NOW - 45_000, proxyRequestID: "req_50" }),
      step("msg_2", { created: NOW - 12_000, completed: NOW - 11_000, proxyRequestID: "req_12" }),
      step("msg_3", { created: NOW - 2_000, completed: NOW - 1_000, proxyRequestID: "req_2" }),
    ]
    const requests = [request(2), webCall(3, 203), webCall(13, 193), request(50)]
    await using setup = await requestsTab({ requests, messages, delay: 0 })
    await clickCacheItem(setup)
    await setup.frame((frame) => rowsOf(frame).length === 4)
    for (const [index, moves] of [
      [1, 1],
      [2, 2],
    ] as const) {
      setup.app.mockInput.pressArrow("down")
      await setup.frame(() => selectedTime(setup) === time(index === 1 ? 3 : 13))
      setup.app.mockInput.pressEnter()
      await until(() => setup.moves.length === moves, 5_000, `move ${moves}`)
    }
    expect(setup.moves).toEqual([`${CHAT} msg_3`, `${CHAT} msg_2`])
  })
})

test("500 rows scroll with six rows mounted", async () => {
  const requests = Array.from({ length: 500 }, (_, index) => request(index))
  await using setup = await requestsTab({ requests, delay: 0 })
  setup.fake.delay = 0
  await clickCacheItem(setup)
  await setup.frame((frame) => rowsOf(frame).length > 0)
  const start = performance.now()
  let steps = 0
  while (setup.pacer.page(CHAT, "all")!.items.length < 500 || selectedTime(setup) !== time(499)) {
    setup.app.mockInput.pressArrow("down")
    await setup.app.renderOnce()
    steps++
    if (steps > 600) throw new Error(`stuck at ${selectedTime(setup)}`)
  }
  const perStep = (performance.now() - start) / steps
  console.log(`500 rows: ${steps} steps down, ${perStep.toFixed(2)} ms per step with its frame`)
  expect(rowsOf(setup.app.captureCharFrame())).toEqual(range(494, 500))
  expect(mountedRows(setup.app.renderer.root)).toBe(6)
})

function selected(frame: RecordedFrame) {
  return frame.lines
    .find((line) => line.spans.some((span) => KIND.test(span.text) && span.attributes & 1))
    ?.spans.map((span) => span.text)
    .join("")
    .match(KIND)?.[1]
}

/**
 * The time of the row drawn selected (bold) now; undefined while the renderer writes a frame, when its spans can't be
 * read (OpenTUI's `OutputBusy`), so wait on it with `setup.frame`.
 */
function selectedTime(setup: Setup) {
  let spans: ReturnType<Setup["app"]["captureSpans"]>
  try {
    spans = setup.app.captureSpans()
  } catch (error) {
    if (error instanceof Error && error.message.includes("OutputBusy")) return undefined
    throw error
  }
  return spans.lines
    .find((line) => line.spans.some((span) => KIND.test(span.text) && span.attributes & 1))
    ?.spans.map((span) => span.text)
    .join("")
    .match(KIND)?.[1]
}

/** The lines a frame draws selected (bold). */
function selectedLines(frame: RecordedFrame) {
  return frame.lines.filter((line) => line.spans.some((span) => KIND.test(span.text) && span.attributes & 1))
}

function mountedRows(node: Renderable): number {
  const own = node instanceof TextRenderable && KIND.test(node.plainText) ? 1 : 0
  return own + node.getChildren().reduce((sum, child) => sum + mountedRows(child), 0)
}
