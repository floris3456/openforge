import { Deferred, Effect, Exit, Stream } from "effect"
import type { Event } from "@opencode/schema/event"
import type { Bus } from "@opencode/core/bus"
import type { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"

// What the continuity tests share: a service generation's events, and what a Session ended with.

/** Every event a generation published from now on, and a way to wait for one. */
export const record = (bus: Bus.Interface) =>
  Effect.gen(function* () {
    const events: Event.Payload[] = []
    let signal = Deferred.makeUnsafe<void>()
    yield* bus.subscribe().pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event)
          const previous = signal
          signal = Deferred.makeUnsafe()
          Deferred.doneUnsafe(previous, Exit.void)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    const of = <D extends Event.Definition>(definition: D) =>
      events.filter((event): event is Event.Payload<D> => event.type === definition.type)
    const waitFor = <D extends Event.Definition>(
      definition: D,
      predicate: (event: Event.Payload<D>) => boolean = () => true,
    ): Effect.Effect<Event.Payload<D>> =>
      Effect.suspend(() => {
        const found = of(definition).find(predicate)
        if (found) return Effect.succeed(found)
        return Deferred.await(signal).pipe(Effect.andThen(waitFor(definition, predicate)))
      })
    return { events, of, waitFor }
  })

export type Recorded = Effect.Success<ReturnType<typeof record>>

/** Resolves once the Session's execution has succeeded. */
export const succeeded = (events: Recorded, sessionID: Session.ID) =>
  events.waitFor(SessionEvent.Execution.Succeeded, (event) => event.data.sessionID === sessionID)

/** The Session's messages as one string, to look for text in. */
export const transcript = (sessions: Session.Interface, sessionID: Session.ID) =>
  sessions.messages({ sessionID }).pipe(Effect.map((messages) => JSON.stringify(messages)))
