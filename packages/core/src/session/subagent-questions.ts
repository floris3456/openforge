export * as SubagentQuestions from "./subagent-questions.js"

import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index.js"
import type { Tool } from "../tool.js"
import { QuestionTool } from "../tool/plugin/question.js"
import type { SessionSchema } from "./schema.js"

// openforge: a subagent's questions belong to its lead (the workspace's task qty37j716xs8). The question tool shows
// its question on the person's screen, so a chat with a parent, whatever agent it runs, is offered none, and its
// instructions tell it to put the question in its reply, where its lead decides or asks the person.

export const text =
  "You are a subagent, so you have no question tool: put any question for your lead in your reply, and your lead decides or asks the person."

/**
 * The chat's tools: a subagent's without the question tool. A start recorded before may still offer it
 * (`SessionPromptStart`); its call then finds the tool unavailable.
 */
export function tools(session: SessionSchema.Info, snapshot: Tool.Snapshot): Tool.Snapshot {
  if (session.parentID === undefined) return snapshot
  const definitions = snapshot.definitions.filter((tool) => tool.name !== QuestionTool.name)
  return {
    ...snapshot,
    definitions,
    execute: (input) =>
      snapshot.execute({
        ...input,
        definitions: new Map(
          Array.from(input.definitions ?? definitions.map((tool) => [tool.name, tool] as const)).filter(
            ([, tool]) => tool.name !== QuestionTool.name,
          ),
        ),
      }),
  }
}

/** The chat's instruction to put its questions in its reply: a subagent's, none for a top-level chat. */
export function instructions(session: SessionSchema.Info): Instructions.List {
  if (session.parentID === undefined) return Instructions.empty
  return Instructions.make({
    key: Instructions.Key.make("core/subagent-questions"),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(text),
    render: { initial: String, changed: (_previous, current) => current },
  })
}
