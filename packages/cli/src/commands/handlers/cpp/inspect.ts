import { EOL } from "node:os"
import { Effect, Schema } from "effect"
import { Service } from "@opencode/client/effect/service"
import { Product } from "@opencode/schema/product"
import { ServerConnection } from "../../../services/server-connection"
import { errorMessage } from "../../../util/error"

// `openforge cpp` (workspace spec docs/specs/cpp-inspect-cli.md): one read of another project on CLIProxyPacer, through
// the service, which adds the install's client key. Inside a chat the shell tool gives the service's address and a
// token of this start of the service (core's `PacerInspect`, whose names these are); elsewhere the CLI signs in with
// the service's password as every command does, and starts the service when it is not running.
export const URL_VARIABLE = "OPENFORGE_CPP_URL"
export const TOKEN_VARIABLE = "OPENFORGE_CPP_TOKEN"

export const NO_NETWORK =
  "This command's sandbox has no network, so openforge's service can't be reached: run it with the network on."
export const NO_WAY =
  "openforge's service can't be reached from here: run this in an openforge chat or in your own terminal."
export const RESTARTED = "openforge's service restarted since this command began: run it again."

const PREFIX = "/api/experimental/pacer/inspect/"

const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })),
)

/**
 * Reads `path` under the service's inspection routes with `fields` (those undefined left out), and prints the answer:
 * the text on stdout with a last line naming the next page's command, or with `json` CLIProxyPacer's JSON as it came.
 * A refusal or a failure is one line on stderr (with `json`, the error's JSON on stdout) and exit status 1.
 */
export const read = Effect.fn("cli.cpp.read")(function* (
  path: string,
  fields: Readonly<Record<string, string | number | boolean | undefined>>,
  json: boolean,
) {
  const query = new URLSearchParams(
    Object.entries<string | number | boolean | undefined>({ ...fields, format: json ? undefined : "text" }).flatMap(
      ([name, value]) => (value === undefined || value === false ? [] : [[name, value === true ? "1" : String(value)]]),
    ),
  ).toString()
  const way = yield* connect()
  if (typeof way === "string") return fail(way, json)
  const answer = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL(`${PREFIX}${path}${query ? `?${query}` : ""}`, way.url), {
        headers: way.headers,
        redirect: "manual",
      })
      return { response, body: await response.text() }
    },
    catch: (cause) => cause,
  }).pipe(Effect.result)
  if (answer._tag === "Failure")
    return fail(
      way.token ? NO_NETWORK : `openforge's service can't be reached at ${way.url}: ${errorMessage(answer.failure)}`,
      json,
    )
  const response = answer.success.response
  const body = answer.success.body
  if (response.ok) {
    process.stdout.write(body.endsWith("\n") || body === "" ? body : body + EOL)
    const next = response.headers.get("x-pacer-next")
    if (next && !json) process.stdout.write(`Next page: ${asGiven()} --cursor ${next}${EOL}`)
    return
  }
  if (response.status === 401 && way.token) return fail(RESTARTED, json)
  const said = decodeError(body)
  if (said._tag === "None")
    return fail(`openforge's service answered HTTP ${response.status}: ${body.trim().slice(0, 200)}`, json)
  if (json) process.stdout.write(body.endsWith("\n") ? body : body + EOL)
  else process.stderr.write(said.value.error.message + EOL)
  process.exitCode = 1
})

/** The service's address and the headers that open its inspection routes, or why there is none. */
function connect() {
  const url = process.env[URL_VARIABLE]
  const token = process.env[TOKEN_VARIABLE]
  if (url && token) return Effect.succeed({ url, headers: { authorization: `Bearer ${token}` }, token: true })
  // A chat's command without the token (the shell tool sets OPENCODE_SESSION_ID on every one) may not read the
  // service's password, and must not start a service of its own.
  if (process.env.OPENCODE_SESSION_ID) return Effect.succeed(NO_WAY)
  return ServerConnection.resolve({ mismatch: "ignore" }).pipe(
    Effect.map((server) => ({ url: server.endpoint.url, headers: Service.headers(server.endpoint), token: false })),
    Effect.catch((error) => Effect.succeed(`openforge's service can't be reached: ${errorMessage(error)}`)),
  )
}

function fail(message: string, json: boolean) {
  if (json) process.stdout.write(JSON.stringify({ error: { type: "openforge", message } }) + EOL)
  else process.stderr.write(message + EOL)
  process.exitCode = 1
}

/** The command as it was given, without its cursor, quoted for a POSIX shell where it needs to be. */
function asGiven() {
  const args = process.argv.slice(2)
  const kept = args.flatMap((arg, index) =>
    arg === "--cursor" || arg.startsWith("--cursor=") || args[index - 1] === "--cursor" ? [] : [arg],
  )
  return [Product.binary, ...kept]
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(" ")
}
