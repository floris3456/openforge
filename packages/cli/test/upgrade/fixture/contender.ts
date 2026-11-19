// Another openforge process while a test switches releases (`contender` in fixture.ts starts it). It shares the switch
// lock with the test's process, with the same shortened stale window. Once it has written `ready` it waits until the
// switch holds the lock, then, by `mode`:
//   watch   prints "held <release in use>" and "free <release in use>" each time the lock turns held or free, until it
//           is free with `to` in use
//   wait    waits for the lock as a starting `serve --service` does (SwitchLock.wait), then prints the release in use
//   switch  switches from `from` to `to` itself, then prints the outcome, or why it failed
import { EffectFlock } from "@opencode/util/effect-flock"
import { Effect, Schedule } from "effect"
import fs from "node:fs/promises"
import { ReleaseLayout } from "../../../src/upgrade/layout"
import { ReleaseSwitch } from "../../../src/upgrade/switch"
import { SwitchLock } from "../../../src/upgrade/switch-lock"
import { layer, staleAfter, switchTarget, type Contender } from "./fixture"

const input = JSON.parse(process.argv[2] ?? "{}") as Contender
const target = switchTarget(input.directory)
const poll = Schedule.spaced("20 millis")

const program = Effect.gen(function* () {
  const flock = yield* EffectFlock.Service
  const shortened = Effect.provideService(EffectFlock.Service, staleAfter(flock, input.staleMs))
  const held = SwitchLock.held(target.layout.locks).pipe(shortened)
  const current = ReleaseLayout.current(target.layout)
  yield* Effect.promise(() => fs.writeFile(input.ready, ""))
  yield* held.pipe(Effect.repeat({ until: (value) => value, schedule: poll }))
  if (input.mode === "wait") {
    yield* SwitchLock.wait(target.layout.locks).pipe(shortened)
    console.log(yield* current)
    return
  }
  if (input.mode === "switch") {
    const outcome = yield* ReleaseSwitch.run(target, { from: input.from, to: input.to }).pipe(
      shortened,
      Effect.map((result) => JSON.stringify(result)),
      Effect.catch((error) => Effect.succeed(`failed: ${error.message}`)),
    )
    console.log(outcome)
    return
  }
  const state = { held: true }
  console.log(`held ${yield* current}`)
  yield* Effect.gen(function* () {
    const now = yield* held
    if (now === state.held) return undefined
    state.held = now
    const line = `${now ? "held" : "free"} ${yield* current}`
    console.log(line)
    return line
  }).pipe(Effect.repeat({ until: (line) => line === `free ${input.to}`, schedule: poll }))
})

await Effect.runPromise(program.pipe(Effect.provide(layer(input.directory))))
