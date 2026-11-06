import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { Command } from "effect/cli"
import { Commands } from "../src/commands/commands"

const id = "ses_e5180050ffferB1nij3MJqNzhP"

// Every command whose --session continues a session, or creates one under that ID.
const commands = {
  default: Commands.spec,
  mini: Commands.commands.mini.spec,
  run: Commands.commands.run.spec,
}

/** Parses `args` with the command, and returns the session its handler got, or the parse errors' messages. */
const parse = async (name: keyof typeof commands, args: ReadonlyArray<string>) => {
  const sessions: Array<Option.Option<string>> = []
  const command = (commands[name] as typeof Commands.commands.run.spec).pipe(
    Command.withHandler((input) => Effect.sync(() => void sessions.push(input.session))),
  )
  const exit = await Effect.runPromise(
    Command.runWith(command, { version: "test", renderErrors: false })(args).pipe(
      Effect.exit,
      Effect.provide(NodeServices.layer),
    ),
  )
  if (Exit.isSuccess(exit)) return { sessions }
  const error = Cause.squash(exit.cause) as { readonly errors?: ReadonlyArray<{ readonly message: string }> }
  return { sessions, errors: (error.errors ?? []).map((item) => item.message) }
}

describe("--session", () => {
  for (const name of Object.keys(commands) as Array<keyof typeof commands>) {
    test(`${name}: takes a session ID the server makes, and one of a user's own`, async () => {
      for (const value of [id, "ses_my-task.2"])
        for (const flag of ["-s", "--session"])
          expect(await parse(name, [flag, value])).toEqual({ sessions: [Option.some(value)] })
    })

    test(`${name}: refuses an ID with a line break, a space, a control character, a non-ASCII character or no ses`, async () => {
      // As a script's capture of the ID gave it twice, one line under the other.
      for (const value of [`${id}\n${id}`, `${id} ${id}`, `${id}\t`, "ses_a\u0001", "ses_\u00fc", id.slice(4)])
        for (const flag of ["-s", "--session"]) {
          const { sessions, errors } = await parse(name, [flag, value])
          expect(sessions).toEqual([])
          expect(errors).toEqual([
            `Invalid value for flag --session: "${value}". Expected a session ID: "ses" and then letters, digits or ASCII punctuation, without spaces, line breaks, other control characters or characters outside ASCII (this one, as JSON: ${JSON.stringify(value)})`,
          ])
        }
    })
  }
})
