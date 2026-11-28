import { expect, test } from "bun:test"
import { ManualClock } from "@opentui/core/testing"
import { createRoot } from "solid-js"
import { createToday, finishTime } from "../src/routes/session/finish-time"

// The words of a reply's finish time (the workspace's spec docs/specs/finish-times.md, section 1), on this machine's
// clock: every moment below is made in its time zone.

const moment = (month: number, day: number, hours: number, minutes: number, seconds = 0) =>
  new Date(2026, month, day, hours, minutes, seconds).getTime()

test("a reply finished today reads as its 24-hour time", () => {
  const today = moment(10, 28, 12, 0)
  expect(finishTime(moment(10, 28, 17, 22), today)).toBe("17:22")
  expect(finishTime(moment(10, 28, 9, 5, 59), today)).toBe("09:05")
  expect(finishTime(moment(10, 28, 0, 0), today)).toBe("00:00")
  expect(finishTime(moment(10, 28, 23, 59, 59), today)).toBe("23:59")
})

test("a reply finished on another day reads with its day and month", () => {
  const today = moment(10, 28, 0, 0, 1)
  expect(finishTime(moment(10, 27, 17, 22), today)).toBe("27 Nov 17:22")
  expect(finishTime(moment(10, 27, 23, 59, 59), today)).toBe("27 Nov 23:59")
  expect(finishTime(moment(0, 3, 0, 7), today)).toBe("3 Jan 00:07")
  expect(finishTime(moment(8, 9, 8, 30), today)).toBe("9 Sep 08:30")
})

test("today moves on at midnight while a reader is mounted, and its timer stops with the last", () => {
  const clock = new ManualClock()
  clock.setTime(moment(10, 27, 23, 59, 30))
  createRoot((dispose) => {
    const today = createToday(clock)()
    expect(finishTime(moment(10, 27, 17, 22), today())).toBe("17:22")
    clock.advance(29_999)
    expect(finishTime(moment(10, 27, 17, 22), today())).toBe("17:22")
    clock.advance(1)
    expect(finishTime(moment(10, 27, 17, 22), today())).toBe("27 Nov 17:22")
    clock.advance(86_400_000)
    expect(finishTime(moment(10, 28, 17, 22), today())).toBe("28 Nov 17:22")
    expect(clock.pendingTimerCount).toBe(1)
    dispose()
  })
  expect(clock.pendingTimerCount).toBe(0)
})
