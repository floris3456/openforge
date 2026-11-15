export * as PacerIdle from "./idle.js"

import { Clock, Context, Effect, FiberSet, Layer, Stream } from "effect"
import type { SessionID } from "@opencode/schema/session-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { SessionEvent } from "../session/event.js"
import { PacerEndpoint } from "./endpoint.js"
import { PacerHeaders } from "./headers.js"
import { PacerHttp } from "./http.js"
import { PacerModels } from "./models.js"

// openforge's idle notice (workspace reference `docs/reference/goals-board-api.md`, "openforge's idle notice"): each
// time a chat's execution goes idle (a turn ended, the person stopped it, or it failed) while its latest step went
// through CLIProxyPacer, and CPP's capabilities say memory `goals`, openforge tells CPP so that it ends the chat's open
// stretch of active time then. Fire and forget: the notice runs on a fiber of its own, never awaited by the chat, and
// its failure is only logged. A subagent's run is its own chat's, so it sends its own.

export const PATH = "/pacer/v1/chats/idle"
/** How long a notice may take before it is given up. */
export const TIMEOUT = "5 seconds"
/** Chats held whose latest step went through CPP; past it the oldest goes. */
export const CHATS = 1_000

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerIdle") {}

const provider: string = PacerEndpoint.id

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const http = yield* PacerHttp.Service
    const models = yield* PacerModels.Service
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    // The chats whose latest step went through CPP, as this process saw them start.
    const running = new Set<SessionID>()

    const send = Effect.fnUntraced(function* (sessionID: SessionID) {
      if ((yield* models.get())?.pacer?.memory?.goals !== true) return
      const at = yield* Clock.currentTimeMillis
      yield* http.notify(PATH, { at }, { timeout: TIMEOUT, headers: PacerHeaders.chat({ sessionID }) })
    })

    yield* bus
      .subscribe([
        SessionEvent.Step.Started,
        SessionEvent.Execution.Succeeded,
        SessionEvent.Execution.Failed,
        SessionEvent.Execution.Interrupted,
        SessionEvent.Deleted,
      ])
      .pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            const sessionID = event.data.sessionID
            if (event.type === "session.step.started") {
              running.delete(sessionID)
              if (event.data.model.providerID !== provider) return
              running.add(sessionID)
              if (running.size > CHATS) running.delete(running.values().next().value!)
              return
            }
            if (!running.delete(sessionID) || event.type === "session.deleted") return
            // A shutdown or a run taken over ends no work: the chat goes on when it resumes.
            if (
              event.type === "session.execution.interrupted" &&
              (event.data.reason === "shutdown" || event.data.reason === "superseded")
            )
              return
            fork(
              send(sessionID).pipe(
                Effect.catch((error) =>
                  Effect.logDebug("CLIProxyPacer was not told a chat went idle", { sessionID, reason: error.message }),
                ),
              ),
            )
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )

    return Service.of({})
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Bus.node, PacerHttp.node, PacerModels.node],
})
