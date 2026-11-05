import { expect, test } from "bun:test"
import { spokenDuration } from "../src/continuity"
import { describeWork, switchingMessage, waitingMessage } from "../src/promise"

const tool = (sessionID: string, name = "webfetch") => ({ sessionID, kind: "tool" as const, name })

test("says what a pause waits for, naming each chat by its title", () => {
  const waiting = [
    // A chat in the middle of a reply reports its model call and its step: one reply.
    { sessionID: "ses_a", kind: "model" as const, name: "slow", title: "Fix the tests" },
    { sessionID: "ses_a", kind: "step" as const, name: "reply", title: "Fix the tests" },
    { ...tool("ses_b"), title: "Docs" },
    { sessionID: "ses_c", kind: "model" as const, name: "slow" },
    { kind: "model" as const, name: "slow" },
    { kind: "step" as const, name: "compaction" },
  ]
  expect(describeWork(waiting)).toBe(
    'a reply in "Fix the tests", webfetch in "Docs", a reply in an untitled chat, a model call, a step',
  )
  // A screen that knows a chat's title names it when the switch could not.
  expect(describeWork([tool("ses_c")], (sessionID) => (sessionID === "ses_c" ? "Release notes" : undefined))).toBe(
    'webfetch in "Release notes"',
  )
  expect(describeWork([])).toBe("the work that was still running")
})

test("says what a switch does and what it waits for", () => {
  expect(switchingMessage("0.1.1")).toBe("Switching to openforge 0.1.1")
  expect(switchingMessage("0.1.1", [{ ...tool("ses_a"), title: "Docs" }])).toBe(
    'Switching to openforge 0.1.1; waiting for webfetch in "Docs"',
  )
  // A switch another screen runs, whose version this one does not know.
  expect(switchingMessage(undefined, [])).toBe("Switching to a new openforge release")
})

test("says why an installed release is not in use yet, with the limit the pause had", () => {
  expect(waitingMessage({ type: "waiting", version: "0.1.1" })).toBe(
    "openforge 0.1.1 is installed. The running service cannot pause; it switches once no chat is running.",
  )
  expect(
    waitingMessage({ type: "waiting", version: "0.1.1", expired: { limit: 300_000, waiting: [tool("ses_a")] } }),
  ).toBe(
    "openforge 0.1.1 is installed. The chats did not pause within 5 minutes; it switches once this has finished: webfetch in an untitled chat.",
  )
})

test("puts a limit in words", () => {
  expect(spokenDuration(120_000)).toBe("2 minutes")
  expect(spokenDuration(60_000)).toBe("1 minute")
  expect(spokenDuration(5_000)).toBe("5 seconds")
  expect(spokenDuration(1_000)).toBe("1 second")
  expect(spokenDuration(1_500)).toBe("1.5 seconds")
  expect(spokenDuration(90_000)).toBe("90 seconds")
  expect(spokenDuration(300)).toBe("300 ms")
})
