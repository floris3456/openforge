export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect } from "effect"
import { Bus } from "../../bus.js"
import type { SessionContinuity } from "../../continuity.js"
import { ModelRetry } from "../../model-retry.js"
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
}

export const policy = (sessionID: SessionSchema.ID, from?: ModelRetry.Progress) =>
  Effect.gen(function* () {
    const retry = yield* ModelRetry.resume(from)
    const decide = (input: Input) =>
      Effect.gen(function* () {
        const next = yield* retry.decide(input)
        if (!next) return { retry: false as const }
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt: next.attempt,
          decision: next.retry ? { retry: true, delay: next.delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0
            ? Math.ceil(event.decision.delay)
            : next.delay
        return { retry: true as const, attempt: next.attempt, delay: normalized }
      })
    return Object.assign(decide, { progress: retry.progress })
  })

/**
 * Retry waits for one logical step. Each wait is stored with its deadline and attempt count, so a restart waits only
 * the time left and keeps counting from `from`.
 */
export const make = (
  bus: Bus.Interface,
  continuity: SessionContinuity.Interface,
  sessionID: SessionSchema.ID,
  step: number,
  from?: SessionContinuity.RetryRest,
) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID, from)
    const until = (at: number) =>
      continuity
        .idle(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(Math.max(0, at - (yield* Clock.currentTimeMillis))))
          }),
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
                at,
                error: input.error,
              }),
          },
        )
        yield* until(at)
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
