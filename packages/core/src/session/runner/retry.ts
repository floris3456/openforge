export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Pacer } from "@opencode/schema/pacer"
import { Clock, Duration, Effect, Stream } from "effect"
import { Bus } from "../../bus.js"
import type { SessionContinuity } from "../../continuity.js"
import { ModelRetry } from "../../model-retry.js"
import { PacerAnswers } from "../../pacer/answers.js"
import type { PacerEndpoint } from "../../pacer/endpoint.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

export { isRetryable }

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
  /** A wait for a free login of this model: CPP's `ready` notice for it ends the wait early. */
  readonly login?: Model.Ref
}

/**
 * Where a step's retries stand: ModelRetry's count, when the run of CLIProxyPacer outages it is in began, and until when
 * its run of waits for a free login does not count against ModelRetry's.
 */
export interface Progress extends ModelRetry.Progress {
  readonly outageSince?: number
  readonly noLoginUntil?: number
}

/**
 * The longest wait for a free login before the step asks CPP again, whatever its `Retry-After` said: a login can come
 * back sooner (a renewal, a reset, an unpause), which CPP's `ready` notice tells at once, and this bounds the wait when
 * no notice comes (a CPP before 2026-11-19, a stream that was down).
 */
export const NO_LOGIN_WAIT = 60_000
/** The longest `Retry-After` a run of waits for a free login trusts, as ModelRetry's `RETRY_AFTER_MAX`. */
const NO_LOGIN_FOR = 15 * 60_000

/** With `endpoints`, an outage first moves to another of CPP's addresses that answers, and then retries at once. */
export const policy = (sessionID: SessionSchema.ID, from?: Progress, endpoints?: PacerEndpoint.Interface) =>
  Effect.gen(function* () {
    const retry = yield* ModelRetry.resume(from)
    // On the CLIProxyPacer provider: whether the last failure was a 502, when the run of outages began, and until when
    // the run of refusals for want of a free login is free of ModelRetry's count.
    let badGateway = false
    let outageSince = from?.outageSince
    let noLoginUntil = from?.noLoginUntil
    const decide = (input: Input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const gateway = PacerAnswers.badGateway(input.model, input.cause)
        outageSince = input.retry && PacerAnswers.outage(input.model, input.cause) ? (outageSince ?? now) : undefined
        // No free login: the wait is the Retry-After or NO_LOGIN_WAIT, whichever is shorter, and the tries before the
        // first such answer's Retry-After ends are free; past it they count as any retry.
        const noLogin = input.retry && PacerAnswers.noLogin(input.model, input.cause)
        const retryAfterMs = "retryAfterMs" in input.cause.reason ? input.cause.reason.retryAfterMs : undefined
        noLoginUntil = noLogin ? (noLoginUntil ?? now + Math.min(retryAfterMs ?? 0, NO_LOGIN_FOR)) : undefined
        const free = noLogin && now < (noLoginUntil ?? now)
        const counted = free
          ? { retry: true, attempt: retry.progress().attempt, delay: retryAfterMs ?? NO_LOGIN_WAIT }
          : yield* retry.decide({
              ...input,
              // CPP's 502 says Retry-After: 30, yet the next request usually reaches the other instance at once.
              skipRetryAfter: gateway && !badGateway,
              // A chat waits out a CPP restart: 30 minutes from the run's first failure, as OpenCodePlus's outage.ts.
              pastSchedule: outageSince !== undefined && now - outageSince < PacerAnswers.OUTAGE_RETRY_FOR,
            })
        const next = counted && noLogin ? { ...counted, delay: Math.min(counted.delay, NO_LOGIN_WAIT) } : counted
        badGateway = gateway
        if (!next) return { retry: false as const }
        const moved =
          next.retry && outageSince !== undefined && endpoints?.failover ? yield* endpoints.failover() : false
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt: next.attempt,
          decision: next.retry ? { retry: true, delay: moved ? 0 : next.delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0
            ? Math.ceil(event.decision.delay)
            : moved
              ? 0
              : next.delay
        return {
          retry: true as const,
          attempt: next.attempt,
          delay: normalized,
          ...(noLogin ? { login: input.model } : {}),
        }
      })
    return Object.assign(decide, { progress: (): Progress => ({ ...retry.progress(), outageSince, noLoginUntil }) })
  })

/**
 * Retry waits for one logical step. Each wait is stored with its deadline and attempt count, so a restart waits only
 * the time left and keeps counting from `from`. A wait ends early, and the step tries again at once, when a message
 * steers the chat, and, for a wait for a free login, on CPP's `ready` notice for its model.
 */
export const make = (
  bus: Bus.Interface,
  continuity: SessionContinuity.Interface,
  sessionID: SessionSchema.ID,
  step: number,
  from?: SessionContinuity.RetryRest,
  endpoints?: PacerEndpoint.Interface,
) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID, from, endpoints)
    const steered = bus
      .subscribe(SessionEvent.InboxEnqueued)
      .pipe(
        Stream.filter(
          (event) =>
            event.data.sessionID === sessionID &&
            (event.data.item.type === "user" || event.data.item.type === "synthetic") &&
            event.data.item.delivery === "steer",
        ),
      )
    const ready = (login: Model.Ref) =>
      bus.subscribe(Pacer.Event.LoginsReady).pipe(Stream.filter((event) => PacerAnswers.readyFor(login, event.data)))
    const until = (at: number, login?: Model.Ref) =>
      continuity
        .idle(
          Effect.raceFirst(
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(Math.max(0, at - (yield* Clock.currentTimeMillis))))
            }),
            Stream.runHead(login ? Stream.merge(steered, ready(login)) : steered),
          ),
        )
        .pipe(Effect.andThen(continuity.boundary()), Effect.andThen(continuity.clearRest(sessionID)))
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
      readonly mode?: SessionContinuity.RetryRest["mode"]
    }) =>
      Effect.gen(function* () {
        const at = (yield* Clock.currentTimeMillis) + input.decision.delay
        const progress = decide.progress()
        yield* bus.publish(
          SessionEvent.RetryScheduled,
          {
            sessionID,
            assistantMessageID: input.assistantMessageID,
            attempt: input.decision.attempt,
            at,
            error: input.error,
          },
          {
            commit: () =>
              continuity.save(sessionID, {
                kind: "retry",
                step,
                assistantMessageID: input.assistantMessageID,
                mode: input.mode ?? "retry",
                attempt: input.decision.attempt,
                timeouts: progress.timeouts,
                outageSince: progress.outageSince,
                noLoginUntil: progress.noLoginUntil,
                at,
                error: input.error,
              }),
          },
        )
        yield* until(at, input.decision.login)
      })
    // A shutdown cleared the shown retry; show the stored one again, then wait only the time left.
    const resume = (rest: SessionContinuity.RetryRest) =>
      bus
        .publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: rest.assistantMessageID,
          attempt: rest.attempt,
          at: rest.at,
          error: rest.error,
        })
        .pipe(Effect.andThen(until(rest.at)))
    return { decide, wait, resume }
  })
