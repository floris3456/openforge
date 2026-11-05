import { Shell } from "@opencode/core/shell"
import { Location } from "@opencode/core/location"
import { Effect, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { ShellNotFoundError } from "@opencode/protocol/errors"
import { Api } from "../api"
import { response } from "../location"

const missing = (id: string) => new ShellNotFoundError({ id, message: `Shell command not found: ${id}` })

export const ShellHandler = HttpApiBuilder.group(Api, "server.shell", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "shell.list",
        Effect.fn(function* () {
          const shell = yield* Shell.Service
          return yield* response(shell.list())
        }),
      )
      .handle(
        "shell.create",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          const location = yield* Location.Service
          return yield* response(
            shell.create({ ...ctx.payload, cwd: ctx.payload.cwd || location.directory }).pipe(Effect.orDie),
          )
        }),
      )
      .handle(
        "shell.get",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          return yield* response(
            shell.get(ctx.params.id).pipe(Effect.catchTag("Shell.NotFoundError", () => missing(ctx.params.id))),
          )
        }),
      )
      .handle(
        "shell.output",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          return yield* response(
            shell
              .output(ctx.params.id, { cursor: ctx.query.cursor, limit: ctx.query.limit })
              .pipe(Effect.catchTag("Shell.NotFoundError", () => missing(ctx.params.id))),
          )
        }),
      )
      .handle(
        "shell.watch",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          yield* shell.get(ctx.params.id).pipe(Effect.catchTag("Shell.NotFoundError", () => missing(ctx.params.id)))
          // Removed while watched: the stream just ends.
          return shell
            .watch(ctx.params.id, { cursor: ctx.query.cursor })
            .pipe(Stream.catchTag("Shell.NotFoundError", () => Stream.empty))
        }),
      )
      .handle(
        "shell.remove",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          yield* shell.remove(ctx.params.id).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.void))
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
