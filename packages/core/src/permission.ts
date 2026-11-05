export * as Permission from "./permission.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect"
import { Permission } from "@opencode/schema/permission"
import { Bus } from "./bus.js"
import { SessionContinuity } from "./continuity.js"
import { Location } from "./location.js"
import { Agent } from "./agent.js"
import { SessionErrors } from "./session/error.js"
import { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { Wildcard } from "./util/wildcard.js"
import { PermissionSaved } from "./permission/saved.js"
import { PluginHooks } from "./plugin/hooks.js"

const PermissionEffect = Permission.Effect
export { PermissionEffect as Effect }
export { Rule, Ruleset } from "@opencode/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export interface AssertInput extends Omit<Request, "id" | "message"> {
  readonly id?: ID
  readonly agent?: Agent.ID
}

export interface ReplyInput {
  readonly requestID: ID
  readonly reply: Reply
  readonly message?: string
  /** Replies only to a request of this Session. */
  readonly sessionID?: SessionSchema.ID
}

export interface AskResult {
  readonly id: ID
  readonly effect: Permission.Effect
}

export { Event } from "@opencode/schema/permission"

/**
 * Rules that settle a request which would otherwise ask, for work nobody is present to answer, such as a schedule's
 * check. A request they do not allow is denied. Configured denies still win, as they are evaluated first.
 */
export const Unattended = Context.Reference<Permission.Ruleset | undefined>("@opencode/Permission/Unattended", {
  defaultValue: () => undefined,
})

export class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedError<CorrectedError>()("Permission.CorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return this.feedback
  }
}

export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
  reason: Schema.String.pipe(Schema.optional),
}) {
  override get message() {
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

/** Whether a rerun tool asks what it asked before the restart; a changed file changes the metadata's diff. */
function sameRequest(left: Request, right: Request) {
  return (
    left.action === right.action &&
    SessionContinuity.same(left.resources, right.resources) &&
    SessionContinuity.same(left.save ?? [], right.save ?? []) &&
    SessionContinuity.same(left.metadata ?? {}, right.metadata ?? {})
  )
}

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  /** Fails only when the rules deny the request; never asks the user. */
  readonly assertNotDenied: (input: AssertInput) => Effect.Effect<void, BlockedError | SessionErrors.NotFoundError>
  /** True only when the rules already allow the request; never asks the user. */
  readonly allows: (input: AssertInput) => Effect.Effect<boolean, SessionErrors.NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: Agent.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
  /** Stored, so the rerun of the asking tool after a restart finds it, and its answer. */
  readonly durable: boolean
}

const StoredReply = Schema.Struct({ reply: Reply, message: Schema.optional(Schema.String) })
const decodeRequest = Schema.decodeUnknownOption(Request)
const decodeReply = Schema.decodeUnknownOption(StoredReply)
// Replies a client may resend; enough for any burst of asks.
const REPLIED_LIMIT = 1_000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const hooks = yield* PluginHooks.Service
    const continuity = yield* SessionContinuity.Service
    const pending = new Map<ID, Pending>()
    const replied = new Map<ID, SessionSchema.ID>()
    let closed = false

    const settle = (deferred: Pending["deferred"], reply: typeof StoredReply.Type) => {
      if (reply.reply !== "reject") return Deferred.succeed(deferred, undefined)
      return Deferred.fail(
        deferred,
        reply.message ? new CorrectedError({ feedback: reply.message }) : new DeclinedError(),
      )
    }

    // Serializes a rerun taking its stored request with an answer to that stored request.
    const restoring = Semaphore.makeUnsafe(1)

    const remember = (request: Request) => {
      replied.set(request.id, request.sessionID)
      if (replied.size <= REPLIED_LIMIT) return
      const [oldest] = replied.keys()
      replied.delete(oldest)
    }

    const close = Effect.gen(function* () {
      closed = true
      // A stopping process keeps its stored requests for the rerun of their tools in the next one.
      const declined = continuity.stopping() ? [] : Array.from(pending.values())
      yield* Effect.forEach(declined, (item) =>
        bus
          .publish(Permission.Event.Replied, {
            sessionID: item.request.sessionID,
            requestID: item.request.id,
            reply: "reject",
          })
          .pipe(
            Effect.ensuring(Deferred.fail(item.deferred, new DeclinedError())),
            Effect.ensuring(item.durable ? continuity.requests.remove(item.request.id) : Effect.void),
          ),
      )
      pending.clear()
    }).pipe(Effect.uninterruptible)
    yield* Effect.addFinalizer(() => close)

    const savedRules = Effect.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({
          action: item.action,
          resource: item.resource,
          effect: "allow",
        }),
      )
    })

    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? [])
    })

    function denied(input: Pick<Request, "action" | "resources">, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("ask") ? "ask" : "allow"
      const event = yield* hooks.trigger("permission", "evaluate", {
        sessionID: input.sessionID,
        agent: input.agent,
        action: input.action,
        resources: input.resources,
        metadata: input.metadata,
        source: input.source,
        effect,
      })
      const unattended = yield* Unattended
      if (event.effect !== "ask" || unattended === undefined)
        return { effect: event.effect, message: event.message, rules: all }
      const settled = [...all, ...unattended]
      const allowed = input.resources.every((resource) => evaluate(input.action, resource, settled).effect === "allow")
      if (allowed) return { effect: "allow" as const, rules: all }
      return {
        effect: "deny" as const,
        message: `Permission ${input.action} needs approval, and nobody is present to give it`,
        rules: all,
      }
    })

    function request(input: AssertInput, message?: string): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        // Tools copy optional inputs straight into metadata; undefined values are not JSON and would
        // fail the HttpApi response encoder when clients list pending requests.
        metadata:
          input.metadata &&
          Object.fromEntries(Object.entries(input.metadata).filter(([, value]) => value !== undefined)),
        source: input.source,
        message,
      }
    }

    /** What the asking tool call asked before a restart, when this call is its rerun. */
    const stored = (input: Pick<Request, "sessionID" | "source">) =>
      Effect.gen(function* () {
        if (input.source === undefined || !(yield* continuity.rerun(input.source.id))) return undefined
        return yield* continuity.requests.find("permission", {
          sessionID: input.sessionID,
          messageID: input.source.messageID,
          callID: input.source.id,
        })
      })

    const create = (request: Request, agent?: Agent.ID, durable = false) =>
      restoring.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
            const before = durable ? yield* stored(request) : undefined
            const previous = before && Option.getOrUndefined(decodeRequest(before.request))
            // The rerun asks what it asked before: the same request, shown with the same id, and any answer applies.
            const same = before && previous && before.agent === agent && sameRequest(previous, request)
            if (before && !same) yield* continuity.requests.remove(before.id)
            const value = same ? { ...request, id: previous.id } : request
            const item: Pending = { request: value, agent, deferred, durable }
            const answered = same ? Option.getOrUndefined(decodeReply(before.reply)) : undefined
            if (answered) {
              yield* settle(deferred, answered)
              return item
            }
            if (closed) {
              yield* Deferred.fail(deferred, new DeclinedError())
              return item
            }
            if (pending.has(value.id))
              return yield* Effect.die(new Error(`Duplicate pending permission ID: ${value.id}`))
            pending.set(value.id, item)
            if (durable && !same && value.source)
              yield* continuity.requests.add({
                id: value.id,
                sessionID: value.sessionID,
                kind: "permission",
                messageID: value.source.messageID,
                callID: value.source.id,
                request: value,
                ...(agent === undefined ? {} : { agent }),
              })
            yield* bus
              .publish(Permission.Event.Asked, value)
              .pipe(Effect.onError(() => Effect.sync(() => pending.delete(value.id))))
            return item
          }),
        ),
      )

    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      if (closed) return { id: input.id ?? ID.create(), effect: "deny" as const }
      const result = yield* evaluateInput(input)
      const value = request(input, result.message)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.die(new DeclinedError())
        const result = yield* evaluateInput(input)
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (result.effect === "deny") {
              return yield* new BlockedError({
                rules: relevant(input, result.rules),
                permission: input.action,
                resources: input.resources,
                reason: result.message,
              })
            }
            if (result.effect === "allow") return
            // A wait the tool can rerun after a stop is stored; the rerun's request then takes the stored id.
            const durable = input.source !== undefined && (yield* continuity.survives(input.source.id))
            const item = yield* create(request(input, result.message), input.agent, durable)
            return yield* restore(continuity.wait(input.source?.id, Deferred.await(item.deferred))).pipe(
              // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
              // must not convert a user's decline into model-facing tool output. The decline
              // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
              // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
              // it into ToolFailure and the model continues.
              Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  // A stop keeps the request, and any answer, for the next process.
                  if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && continuity.stopping()) return
                  pending.delete(item.request.id)
                  if (item.durable) yield* continuity.requests.remove(item.request.id)
                }),
              ),
            )
          }),
        )
      }),
    )

    const assertNotDenied = Effect.fn("Permission.assertNotDenied")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      if (result.effect !== "deny") return
      return yield* new BlockedError({
        rules: relevant(input, result.rules),
        permission: input.action,
        resources: input.resources,
        reason: result.message,
      })
    })

    const allows = Effect.fn("Permission.allows")(function* (input: AssertInput) {
      if (closed) return false
      return (yield* evaluateInput(input)).effect === "allow"
    })

    // The answer is stored before it reaches the tool, so a stop in between still delivers it to the rerun.
    const answer = (item: Pending, reply: typeof StoredReply.Type) =>
      Effect.gen(function* () {
        if (item.durable) yield* continuity.requests.reply(item.request.id, reply)
        yield* settle(item.deferred, reply)
        remember(item.request)
        pending.delete(item.request.id)
      })

    // A request asked before a restart whose tool has not run again yet: the answer waits for the rerun.
    const replyStored = (input: ReplyInput) =>
      Effect.gen(function* () {
        const row = yield* continuity.requests.get(input.requestID)
        const request = row?.kind === "permission" ? Option.getOrUndefined(decodeRequest(row.request)) : undefined
        if (!row || !request || (input.sessionID !== undefined && request.sessionID !== input.sessionID))
          return yield* new NotFoundError({ requestID: input.requestID })
        if (row.reply !== undefined && row.reply !== null) return
        yield* continuity.requests.reply(request.id, {
          reply: input.reply,
          ...(input.reply === "reject" && input.message ? { message: input.message } : {}),
        })
        if (input.reply === "always" && request.save?.length)
          yield* saved.add({ projectID: location.project.id, action: request.action, resources: request.save })
        remember(request)
        yield* bus.publish(Permission.Event.Replied, {
          sessionID: request.sessionID,
          requestID: request.id,
          reply: input.reply,
        })
      })

    const asked = (id: ID) => pending.has(id) || replied.has(id)

    const reply = Effect.fn("Permission.reply")(function* (input: ReplyInput) {
      if (asked(input.requestID)) return yield* replyAsked(input)
      // A rerun may be taking its stored request: once it has, the answer is for the request it asked again.
      return yield* restoring
        .withPermit(Effect.suspend(() => (asked(input.requestID) ? replyAsked(input) : replyStored(input))))
        .pipe(Effect.uninterruptible)
    })

    // A request this process asked.
    const replyAsked = (input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          const owner = existing?.request.sessionID ?? replied.get(input.requestID)
          if (owner === undefined || (input.sessionID !== undefined && owner !== input.sessionID))
            return yield* new NotFoundError({ requestID: input.requestID })
          // A client that resends an answer it already gave gets the same success.
          if (!existing) return
          yield* bus.publish(Permission.Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            const stored = { reply: "reject" as const, ...(input.message ? { message: input.message } : {}) }
            yield* answer(existing, stored)
            for (const item of Array.from(pending.values())) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* bus.publish(Permission.Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              // Feedback applies to the whole batch, so parallel asks don't end the step.
              yield* answer(item, stored)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* answer(existing, { reply: input.reply })
          if (input.reply !== "always" || !existing.request.save?.length) return

          for (const item of Array.from(pending.values())) {
            const result = yield* evaluateInput({ ...item.request, agent: item.agent }).pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.undefined),
            )
            if (result?.effect !== "allow") continue
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* answer(item, { reply: "always" })
          }
        }),
      )

    const list = Effect.fn("Permission.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = Effect.fn("Permission.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, assertNotDenied, allows, reply, get, forSession, list, close })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    Location.node,
    Agent.node,
    SessionStore.node,
    PermissionSaved.node,
    PluginHooks.node,
    SessionContinuity.node,
  ],
})
