import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { waitForHighlightedFrame } from "./fixture/frame"
import { directory, json } from "./fixture/tui-client"

// The clock time a reply finished, at the end of the line under it (the workspace's spec docs/specs/finish-times.md,
// section 1): 24-hour on this machine's clock, with the day when that was not today; none while the reply runs; an
// interrupted reply shows when it stopped; the time gives way first on a line that doesn't fit, the rest as it was.

const today = new Date()
/** A moment of `day` on this machine's clock. */
const at = (day: Date, hours: number, minutes: number, seconds = 0) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, seconds).getTime()
const earlier = new Date(2026, 10, 27)

const session = {
  id: "ses_finish_time",
  title: "Finish times",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: at(earlier, 17, 0), updated: at(today, 11, 0) },
}
const tokens = { ...session.tokens, output: 20 }
const reply = (id: string, text: string, time: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  id,
  type: "assistant",
  agent: session.agent,
  model: session.model,
  time,
  finish: "stop",
  cost: 0,
  tokens,
  content: [{ type: "text", text }],
  ...extra,
})
const messages = [
  {
    id: "msg_0008",
    type: "assistant",
    agent: session.agent,
    model: session.model,
    time: { created: at(today, 11, 0, 1) },
    cost: 0,
    tokens: session.tokens,
    content: [{ type: "text", text: "Running answer" }],
  },
  { id: "msg_0007", type: "user", text: "Running question", time: { created: at(today, 11, 0) } },
  reply(
    "msg_0006",
    "Stopped answer",
    { created: at(today, 10, 5), completed: at(today, 10, 5, 1) },
    { finish: "error", error: { type: "aborted", message: "Step interrupted" } },
  ),
  { id: "msg_0005", type: "user", text: "Stopped question", time: { created: at(today, 10, 4, 59) } },
  reply("msg_0004", "Today answer", {
    created: at(today, 9, 40, 58),
    streamed: at(today, 9, 40, 58) + 400,
    completed: at(today, 9, 41),
  }),
  { id: "msg_0003", type: "user", text: "Today question", time: { created: at(today, 9, 40, 57) } },
  reply("msg_0002", "Earlier answer", {
    created: at(earlier, 17, 21, 58),
    streamed: at(earlier, 17, 21, 58) + 500,
    completed: at(earlier, 17, 22),
  }),
  { id: "msg_0001", type: "user", text: "Earlier question", time: { created: at(earlier, 17, 21, 57) } },
]

/** The first line under a reply with `rest` in it, trimmed, without the scrollbar's thumb beside it. */
const footer = (frame: string, rest: string) =>
  frame
    .split("\n")
    .map((line) => line.replace(/\s*█\s*$/, "").trim())
    .find((line) => line.startsWith("Build ·") && line.includes(rest))
/** The first line with words under the first line with `text` in it, trimmed. */
const below = (frame: string, text: string) => {
  const lines = frame.split("\n").map((line) => line.trim())
  return lines.slice(lines.findIndex((line) => line.includes(text)) + 1).find((line) => line !== "")
}

/** The session at `width` columns, with its running reply or without it. */
const open = (state: string, width: number, input: { running?: boolean; scrollbar?: boolean } = {}) =>
  createAppFixture({
    width,
    height: 50,
    state,
    config: {
      animations: false,
      tabs: { mode: "off" },
      session: { sidebar: "hide", tps: true, scrollbar: input.scrollbar ?? false },
    },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: input.running === false ? messages.filter((message) => message.id !== "msg_0008") : messages,
          cursor: {},
        })
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
      return undefined
    },
  })

test("a reply's line ends with the time it finished, with its day when not today, and none while it runs", async () => {
  await using state = await tmpdir()
  await using setup = await open(state.path, 100)

  const wide = await waitForHighlightedFrame(
    setup,
    (frame) => frame.includes("Earlier answer") && frame.includes("Running answer") && frame.includes("interrupted"),
  )
  expect(footer(wide, "40.0 tok/s")).toBe("Build · fixture/model · 3.0s · 40.0 tok/s · 27 Nov 17:22")
  expect(footer(wide, "50.0 tok/s")).toBe("Build · fixture/model · 3.0s · 50.0 tok/s · 09:41")
  expect(footer(wide, "interrupted")).toBe("Build · fixture/model · 2.0s · interrupted · 10:05")
  // The running reply has no line yet; the session's other lines carry only their own replies' times.
  expect(wide.match(/\d\d:\d\d/g)).toEqual(["17:22", "09:41", "10:05"])

  // A retry is a reply that still runs: its line has no time.
  const error = { type: "provider.transport" as const, message: "Provider unavailable" }
  setup.events.emit({
    id: "evt_finish_retry",
    created: at(today, 11, 0, 2),
    type: "session.retry.scheduled",
    durable: { aggregateID: session.id, seq: 1, version: 1 },
    data: { sessionID: session.id, assistantMessageID: "msg_0008", attempt: 1, at: Date.now() + 60_000, error },
  })
  const retrying = await setup.waitForFrame((frame) => frame.includes("Provider unavailable"))
  expect(below(retrying, "Provider unavailable")).toBe("Build · fixture/model")
  expect(retrying.match(/\d\d:\d\d/g)).toEqual(["17:22", "09:41", "10:05"])

  setup.events.emit({
    id: "evt_finish_started",
    created: at(today, 11, 0, 3),
    type: "session.step.started",
    durable: { aggregateID: session.id, seq: 2, version: 1 },
    data: {
      sessionID: session.id,
      assistantMessageID: "msg_0008",
      agent: session.agent,
      model: session.model,
      started: at(today, 11, 0, 3),
    },
  })
  await setup.waitForFrame((frame) => !frame.includes("Provider unavailable"))
  setup.events.emit({
    id: "evt_finish_ended",
    created: at(today, 11, 30),
    type: "session.step.ended",
    durable: { aggregateID: session.id, seq: 3, version: 1 },
    data: { sessionID: session.id, assistantMessageID: "msg_0008", finish: "stop", cost: 0, tokens: session.tokens },
  })
  const ended = await setup.waitForFrame((frame) => frame.includes("11:30"))
  expect(footer(ended, "11:30")).toBe("Build · fixture/model · 30m 0s · 11:30")
})

test("on a narrow terminal the time gives way first, line by line, and the rest of the line stays", async () => {
  await using state = await tmpdir()
  await using setup = await open(state.path, 100, { running: false })
  await waitForHighlightedFrame(setup, (frame) => frame.includes("Earlier answer") && frame.includes("10:05"))

  // 60 columns: today's lines still fit with their time, the earlier day's doesn't and loses only its time.
  setup.resize(60, 50)
  const middle = await setup.waitForFrame((frame) => frame.includes("Stopped answer") && !frame.includes("27 Nov"))
  expect(footer(middle, "40.0 tok/s")).toBe("Build · fixture/model · 3.0s · 40.0 tok/s")
  expect(footer(middle, "50.0 tok/s")).toBe("Build · fixture/model · 3.0s · 50.0 tok/s · 09:41")
  expect(footer(middle, "interrupted")).toBe("Build · fixture/model · 2.0s · interrupted · 10:05")

  // 56 columns: today's line of 49 fills its room to the last column, on one line; the interrupted one is a column
  // longer and loses its time.
  setup.resize(56, 50)
  const edge = await setup.waitForFrame((frame) => frame.includes("Stopped answer") && !frame.includes("10:05"))
  expect(footer(edge, "50.0 tok/s")).toBe("Build · fixture/model · 3.0s · 50.0 tok/s · 09:41")
  expect(footer(edge, "interrupted")).toBe("Build · fixture/model · 2.0s · interrupted")
  setup.resize(55, 50)
  const past = await setup.waitForFrame((frame) => frame.includes("Stopped answer") && !frame.includes("09:41"))
  expect(footer(past, "50.0 tok/s")).toBe("Build · fixture/model · 3.0s · 50.0 tok/s")

  // 50 columns: no time fits; every line keeps the rest as it was.
  setup.resize(50, 50)
  const narrow = await setup.waitForFrame(
    (frame) => frame.includes("Stopped answer") && !frame.includes("09:41") && !frame.includes("10:05"),
  )
  expect(footer(narrow, "40.0 tok/s")).toBe("Build · fixture/model · 3.0s · 40.0 tok/s")
  expect(footer(narrow, "50.0 tok/s")).toBe("Build · fixture/model · 3.0s · 50.0 tok/s")
  expect(footer(narrow, "interrupted")).toBe("Build · fixture/model · 2.0s · interrupted")
  expect(narrow.match(/\d\d:\d\d/g)).toBeNull()
})

test("a shown scrollbar's columns are not the line's", async () => {
  await using state = await tmpdir()
  await using setup = await open(state.path, 59, { running: false, scrollbar: true })
  const edge = await waitForHighlightedFrame(
    setup,
    (frame) => frame.includes("Stopped answer") && frame.includes("09:41"),
  )
  expect(footer(edge, "50.0 tok/s")).toBe("Build · fixture/model · 3.0s · 50.0 tok/s · 09:41")
  setup.resize(58, 50)
  const past = await setup.waitForFrame((frame) => frame.includes("Stopped answer") && !frame.includes("09:41"))
  expect(footer(past, "50.0 tok/s")).toBe("Build · fixture/model · 3.0s · 50.0 tok/s")
})
