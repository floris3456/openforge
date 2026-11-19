export * as SessionNamedModel from "./named-model.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Model } from "@opencode/schema/model"
import type { SessionID } from "@opencode/schema/session-id"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Clock, Context, Effect, Layer } from "effect"
import { Bus } from "../../bus.js"
import { Location } from "../../location.js"
import { PacerEndpoint } from "../../pacer/endpoint.js"
import { PacerModels } from "../../pacer/models.js"

// openforge: a session without a model of its own runs on the one its agent or the default names. When the catalog
// lacks that model, the run takes another one (`SessionRunnerModel`); this says so, once per session and named model,
// as a log line and a toast in the TUIs of the location. A CLIProxyPacer model is often not listed yet when a run
// starts, as CPP's catalog is read after the service starts, so for one the run first waits for that catalog.

/** The longest a run waits for CLIProxyPacer's catalog to list the model it names. */
export const WAIT_MS = 60_000
const POLL = "250 millis"

type Named = Pick<Model.Ref, "providerID" | "id">

export interface Interface {
  /**
   * For a CLIProxyPacer model the catalog lacks while CPP is set up: waits, at most {@link WAIT_MS}, until `find`
   * finds it, and stops as soon as CPP's catalog is read without it. Undefined for any other model, when not found,
   * and once the session was told it runs on another one.
   */
  readonly wait: (
    sessionID: SessionID,
    asked: Named,
    find: () => Effect.Effect<Model.Info | undefined>,
  ) => Effect.Effect<Model.Info | undefined>
  /** Says that the session asked for `asked` and runs on `running`; once per session and asked model. */
  readonly dropped: (sessionID: SessionID, asked: Named, running: Model.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionNamedModel") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
    const told = new Set<string>()
    const key = (sessionID: SessionID, asked: Named) => `${sessionID} ${name(asked)}`

    return Service.of({
      wait: Effect.fn("SessionNamedModel.wait")(function* (sessionID, asked, find) {
        const PACER: string = PacerEndpoint.id
        if (asked.providerID !== PACER || told.has(key(sessionID, asked))) return undefined
        if (!(yield* endpoints.get())) return undefined
        const deadline = (yield* Clock.currentTimeMillis) + WAIT_MS
        while (true) {
          const found = yield* find()
          if (found) return found
          const catalog = yield* catalogs.get()
          if (catalog && !catalog.models.some((model) => model.id === asked.id)) return undefined
          if ((yield* Clock.currentTimeMillis) >= deadline) return undefined
          yield* Effect.sleep(POLL)
        }
      }),
      dropped: Effect.fn("SessionNamedModel.dropped")(function* (sessionID, asked, running) {
        if (told.has(key(sessionID, asked))) return
        told.add(key(sessionID, asked))
        yield* Effect.logWarning("running a session on another model than the one named", {
          sessionID,
          asked: name(asked),
          running: name(running),
        })
        yield* bus.publish(
          TuiEvent.ToastShow,
          {
            title: "Model unavailable",
            message: `Asked for ${name(asked)}, running ${name(running)}: ${name(asked)} is not available.`,
            variant: "warning",
            duration: 10_000,
          },
          { location: ref },
        )
      }),
    })
  }),
)

function name(model: Named) {
  return `${model.providerID}/${model.id}`
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Location.node, PacerEndpoint.node, PacerModels.node],
})
