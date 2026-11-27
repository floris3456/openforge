export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Option, Predicate, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { SessionContinuity } from "../../continuity.js"
import { Job } from "../../job.js"
import { MemoryHeld } from "../../memory/held.js"
import { MemoryTask } from "../../memory/task.js"
import { Model } from "../../model.js"
import { PacerModels } from "../../pacer/models.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentDepth } from "../../session/subagent-depth.js"
import { SubagentEnded } from "../../session/subagent-ended.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { normalizeContent } from "../runtime.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will receive a <subagent> message when it goes idle, and again after each later round of work.`,
    "DO NOT sleep, poll, proactively check on its progress, or duplicate this subagent's work.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
    "To send it follow-ups or change its instructions while it runs, call subagent again with this sessionID.",
  ].join("\n"),
})

/** What a parent's foreground subagent call stores while it waits, so the next process waits for the same child. */
const Attached = Schema.Struct({ childSessionID: SessionSchema.ID, agent: Schema.String })
const decodeAttached = Schema.decodeUnknownOption(Attached)

export const Input = Schema.Struct({
  agent: Schema.String.annotate({
    description:
      "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can\'t run subagents. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description: "Send a follow-up to an existing subagent, running or finished. Omit to start a new one.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will receive a <subagent> message when it goes idle. DO NOT sleep, poll, or proactively check on its progress.",
  }),
  taskID: Schema.optionalKey(Schema.String).annotate({
    description:
      "The id of the task or subtask (the task tool) this subagent is to work on: the subtask's when it does one step of a plan; give it whenever the work is a task. While you are on a step of a task, that task's own id is refused.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
// openforge: foreground subagents stay the default (specs v0.0.2-tool-runner-and-live-switch, cliproxypacer-step-1).
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it and returns immediately; you receive a `<subagent>` message each time the child goes idle, including after later work. Do not sleep, poll, or proactively check on it.",
  "Use background only for independent work that can run while you continue elsewhere. A follow-up to a running child joins its current run.",
].join("\n")

/**
 * openforge: what the description says while the connected CLIProxyPacer says what a lead owes its helper's rounds
 * (`review_owed`; `MemoryHeld`, the workspace's task khtzd8a7qje3), to a chat without a parent.
 */
export const HELD =
  "A follow-up to a child that handed in a review round you have not answered is held, and given back to you unsent once your task tool marks answer it."

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service
    const tasks = yield* MemoryTask.Service
    const ended = yield* SubagentEnded.Service
    const continuity = yield* SessionContinuity.Service
    const held = yield* MemoryHeld.Service
    const catalogs = yield* PacerModels.Service

    // A foreground call starts the child as a job it waits for. The wait survives a stop: the child rests and resumes
    // itself, and the rerun of this call waits for it again.
    const follow = Effect.fnUntraced(function* (
      recovery: Extract<Job.Recovery, { kind: "subagent" }>,
      sessionID: SessionSchema.ID,
      callID: string,
      rerun = false,
    ) {
      const child = recovery.childSessionID
      yield* subagents.start(recovery, { background: false, rerun })
      const result = yield* continuity
        .wait(callID, jobs.block({ id: child, sessionID }), { childSessionID: child, agent: recovery.agent })
        .pipe(
          Effect.onInterrupt(() =>
            continuity.stopping()
              ? Effect.void
              : Effect.all([sessions.interrupt(child), jobs.cancel(child)], { discard: true }),
          ),
        )
      // Backgrounded while it waited (or already running in the background): its report arrives as a message.
      if (result?.type === "backgrounded") return backgroundResult(child)
      // The stop interrupted the child first; the next process waits for it again.
      if (result?.info.status === "running") return yield* Effect.interrupt
      // Failure surfaces keep the sessionID visible so the model can continue the child.
      if (result?.info.status === "error")
        return yield* new ToolFailure({
          message: `Subagent failed (sessionID: ${child}): ${result.info.error ?? "unknown error"}`,
        })
      if (result?.info.status === "cancelled")
        return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child})` })
      const messages = yield* sessions
        .messages({ sessionID: child, order: "desc", limit: 20 })
        .pipe(Effect.orElseSucceed(() => []))
      const assistant = messages.find(
        (message) =>
          message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
      )
      const output = yield* ended.apply(child, SubagentCompletion.text(assistant))
      return { sessionID: child, status: "completed" as const, output }
    })

    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const model = (yield* models.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (model === undefined) {
        const other = (yield* models.available(["image", "decision"])).find(
          (model) => model.providerID === ref.providerID && model.id === ref.id,
        )
        return yield* new ToolFailure({
          message: other
            ? `Model "${ref.providerID}/${ref.id}" is ${other.type === "image" ? "an image" : "a decision"} model; subagents need a chat model. Use the models tool to find one.`
            : `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      }
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      return ref
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const attached = Option.getOrUndefined(decodeAttached(yield* continuity.resumed(context.id)))
              if (attached) {
                yield* context.progress({ sessionID: attached.childSessionID, status: "running" })
                return yield* follow(
                  {
                    kind: "subagent" as const,
                    parentSessionID: context.sessionID,
                    childSessionID: attached.childSessionID,
                    agent: attached.agent,
                    description: input.description,
                  },
                  context.sessionID,
                  context.id,
                  true,
                )
              }
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              const limit = yield* SubagentDepth.reached(parent, sessions, config).pipe(
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Parent session not found: ${error.sessionID}`, error }),
                ),
              )
              if (limit !== undefined)
                return yield* new ToolFailure({
                  message: `Subagent depth limit reached (${limit}): a subagent can't start its own subagents here. Do this work yourself, or tell your lead what needs another helper.`,
                })
              const agent = yield* agents.resolve(input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  ...Permission.invocation(context),
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              const override = input.model === undefined ? undefined : yield* resolveModel(input.model)
              // openforge: a lead's message to a helper whose handed-in round it has not answered is held, a newer one
              // in place of the one held, until its marks answer it; then it comes back unsent (`MemoryHeld`, the
              // workspace's tasks khtzd8a7qje3 and 2ykxbrh7syva).
              if (existing !== undefined) {
                const owed = yield* held.owed(parent, existing)
                if (owed.length > 0) {
                  yield* held.hold(parent.id, existing.id, { description: input.description, prompt: input.prompt })
                  return yield* new ToolFailure({ message: MemoryHeld.heldText(owed) })
                }
                yield* held.drop(existing.id)
              }
              // Continuing with a different agent switches the child, mirroring create semantics
              // where an explicit model wins over the agent's configured model, which wins over the inherited one.
              if (existing !== undefined) {
                const switched = existing.agent !== agent.id
                const model = override ?? (switched ? agent.model : undefined)
                yield* Effect.all([
                  switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
                  model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
                ]).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              const model = override ?? agent.model ?? parent.model
              // A child started or continued on a task moves into the task as a new one does, and its maker gets the
              // task's state in its reports once the task is no longer active.
              const taskID = input.taskID
              const assigned = taskID === undefined ? undefined : yield* tasks.assign(parent, taskID)
              const child =
                existing ??
                (yield* sessions
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: agent.id,
                    model,
                    ...(assigned ? { metadata: assigned.metadata } : {}),
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))

              // Known and left so: when setting the task active fails, the child session made above already exists.
              if (assigned) {
                const metadata = yield* tasks.activate(assigned, child, agent.id)
                if (metadata) yield* sessions.setMetadata({ sessionID: child.id, metadata }).pipe(Effect.ignore)
              }
              if (taskID !== undefined)
                yield* ended.set(child.id, (output) =>
                  sessions.get(context.sessionID).pipe(
                    Effect.flatMap((current) => tasks.ended(current, taskID, output)),
                    Effect.orElseSucceed(() => output),
                  ),
                )
              // A child that is not draining yet must be admitted without waking: the job's resume
              // owns the start, so the period cannot run before its boundary is registered.
              const running =
                existing !== undefined &&
                ((yield* sessions.active).has(existing.id) || (yield* jobs.get(existing.id))?.status === "running")
              yield* context.progress({ sessionID: child.id, status: "running" })

              yield* sessions
                .prompt({
                  sessionID: child.id,
                  text:
                    existing === undefined
                      ? ["You are a subagent spawned by another session.", input.prompt].join("\n")
                      : input.prompt,
                  ...(running ? {} : { resume: false }),
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              const recovery = {
                kind: "subagent" as const,
                parentSessionID: context.sessionID,
                childSessionID: child.id,
                agent: agent.name,
                description: input.description,
              }
              if (input.background !== true) return yield* follow(recovery, context.sessionID, context.id)
              yield* subagents.start(recovery)
              return backgroundResult(child.id)
            }).pipe(
              Effect.map((output) => ({
                output,
                content:
                  output.status === "completed"
                    ? `<subagent sessionID="${output.sessionID}" state="completed">\n${output.output}\n</subagent>`
                    : output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    /**
     * openforge: a message held for `lead`'s helper comes back once the lead owes it nothing, unsent: the lead wrote it
     * before it saw what it answered. Undefined while still owed; its quote for the lead's answer otherwise.
     */
    const release = Effect.fnUntraced(function* (lead: SessionSchema.Info, item: MemoryHeld.Held) {
      const helper = Option.getOrUndefined(yield* sessions.get(item.helper).pipe(Effect.option))
      if (helper === undefined || helper.parentID !== lead.id)
        return yield* held.drop(item.helper).pipe(Effect.as(undefined))
      if ((yield* held.owed(lead, helper)).length > 0) return undefined
      yield* held.drop(item.helper, item.messageID)
      return MemoryHeld.backText(item)
    })

    // openforge: a lead's task call that leaves its helper owed nothing releases the message held for that helper: the
    // call's answer ends quoting it, for the lead to send again or leave, since what the call answered may change it
    // (`MemoryHeld`, the workspace's tasks khtzd8a7qje3 and 2ykxbrh7syva).
    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.tool !== "task" || event.status !== "completed") return
        const waiting = yield* held.held(event.sessionID)
        if (waiting.length === 0) return
        const lead = yield* sessions.get(event.sessionID)
        const quotes = (yield* Effect.forEach(waiting, (item) => release(lead, item))).filter(
          (quote): quote is string => quote !== undefined,
        )
        if (quotes.length === 0) return
        const content = normalizeContent(event.result.content, event.result.output)
        const notice = quotes.join("\n\n")
        const last = content.findLastIndex((item) => item.type === "text")
        event.result = {
          ...event.result,
          content:
            last === -1
              ? [...content, { type: "text", text: notice }]
              : content.map((item, index) =>
                  index === last && item.type === "text" ? { ...item, text: `${item.text}\n\n${notice}` } : item,
                ),
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not release a lead's held messages", { sessionID: event.sessionID, error }),
        ),
      ),
    )

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "") return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        event.input = input
      }),
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const memory = (yield* catalogs.get())?.pacer?.memory
        if (memory?.reviewOwed === true && memory.tools === true) {
          const session = Option.getOrUndefined(yield* sessions.get(event.sessionID).pipe(Effect.option))
          if (session !== undefined && session.parentID === undefined) tool.description = `${tool.description}\n${HELD}`
        }
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
