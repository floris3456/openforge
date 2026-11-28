import type { Clock, TimerHandle } from "@opentui/core"
import { createSignal, onCleanup } from "solid-js"
import { WallClock } from "../../context/pacer"
import { clockTime } from "../../pacer/format"

// openforge: the clock time a reply finished, at the end of the line under it (the workspace's spec
// docs/specs/finish-times.md, section 1).

// Fixed words, not Intl's: its short September is "Sept" in some locales.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** 17:22 when `ms` is on the day of `today` on this machine's clock, else with its day: 27 Nov 17:22. */
export function finishTime(ms: number, today: number) {
  const date = new Date(ms)
  if (date.toDateString() === new Date(today).toDateString()) return clockTime(ms)
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clockTime(ms)}`
}

/**
 * Today on `clock`, moved on at each midnight so that a reply of the day before gains its day while its chat stays on
 * screen. One timer for every reader, running while one is mounted.
 */
export function createToday(clock: Clock) {
  const [today, setToday] = createSignal(clock.now())
  let readers = 0
  let timer: TimerHandle | undefined
  const tick = () => {
    const now = clock.now()
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    setToday(now)
    timer = clock.setTimeout(tick, midnight.getTime() - now)
  }
  return () => {
    if (readers++ === 0) tick()
    onCleanup(() => {
      if (--readers > 0 || timer === undefined) return
      clock.clearTimeout(timer)
      timer = undefined
    })
    return today
  }
}

export const useToday = createToday(new WallClock())
