// What handing CLIProxyPacer a chat's .env values costs (workspace spec `docs/specs/env-redaction.md`, section 6): the
// first read of a repository's .env files, walked whole with its nested repositories, and the look before each model
// request at what that read found, alone and as the request's HTTP middleware adds it. Run on a folder given (the
// QuettaForge workspace by default) and on a made-up repository of nested ones, each with .env files. Fails when the
// look's median passes the budget.
//   bun run script/benchmark-pacer-env.ts [--root <folder>] [--reads 5] [--rounds 2000] [--repositories 50] [--budget-ms 1]
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { PacerEndpoint } from "../src/pacer/endpoint"
import { PacerEnv } from "../src/pacer/env"
import { PacerHttp } from "../src/pacer/http"
import { PacerModels } from "../src/pacer/models"

const args = process.argv.slice(2)
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]!
}
const root = option("--root", "/home/bliss/QuettaForge")
const reads = Number(option("--reads", "5"))
const rounds = Number(option("--rounds", "2000"))
const repositories = Number(option("--repositories", "50"))
const budget = Number(option("--budget-ms", "1"))

const endpoint = PacerEndpoint.resolve({ baseURL: "http://127.0.0.1:9/v1", apiKey: "client-key-bench" }, undefined)!
const endpointLayer = Layer.succeed(
  PacerEndpoint.Service,
  PacerEndpoint.Service.of({ get: () => Effect.succeed(endpoint), changes: () => Stream.empty }),
)
/** A PacerEnv of its own: a first read of each place again. */
const fresh = () =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(
        Layer.fresh(PacerEnv.layer).pipe(
          Layer.provide(
            Layer.mergeAll(
              PacerHttp.layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpointLayer)),
              endpointLayer,
              Layer.succeed(
                PacerModels.Service,
                PacerModels.Service.of({
                  get: () =>
                    Effect.succeed({
                      at: 0,
                      pacer: { compactTokens: [], webTools: false, redaction: { env: true } },
                      models: [],
                    }),
                  changes: () => Stream.empty,
                  refresh: () => Effect.void,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  ).then((context) => Context.get(context, PacerEnv.Service))

const ms = (nanoseconds: number) => nanoseconds / 1e6
const stats = (samples: Float64Array) => {
  samples.sort()
  return {
    median: ms(samples[samples.length >> 1]!),
    p99: ms(samples[Math.floor(samples.length * 0.99)]!),
    max: ms(samples[samples.length - 1]!),
  }
}

async function measure(label: string, folder: string) {
  const place = { root: folder, deep: true }
  const first = new Float64Array(reads)
  let values = 0
  for (let i = 0; i < reads; i++) {
    const env = await fresh()
    const start = Bun.nanoseconds()
    values = (await Effect.runPromise(env.current(place))).length
    first[i] = Bun.nanoseconds() - start
  }
  const env = await fresh()
  await Effect.runPromise(env.current(place))
  const look = new Float64Array(rounds)
  for (let i = 0; i < rounds; i++) {
    const start = Bun.nanoseconds()
    await Effect.runPromise(env.current(place))
    look[i] = Bun.nanoseconds() - start
  }
  // The request's middleware against the wire alone: what a model request gains, header and digest included.
  const request = HttpClientRequest.post(`${endpoint.root}/v1/messages`)
  const wire = (sent: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(sent, new Response("{}")))
  const middleware = env.http(place)
  const alone = new Float64Array(rounds)
  const through = new Float64Array(rounds)
  for (let i = 0; i < rounds; i++) {
    const a = Bun.nanoseconds()
    await Effect.runPromise(wire(request))
    alone[i] = Bun.nanoseconds() - a
    const b = Bun.nanoseconds()
    await Effect.runPromise(middleware(request, wire))
    through[i] = Bun.nanoseconds() - b
  }
  const result = {
    label,
    root: folder,
    values,
    firstRead: stats(first),
    look: stats(look),
    request: { alone: stats(alone), through: stats(through) },
    added: stats(through).median - stats(alone).median,
  }
  console.log(JSON.stringify(result, null, 2))
  return result
}

/** A repository of `count` nested ones, each with a .env, a .env.local and an example, two folders deep. */
async function madeUp(count: number) {
  const top = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "pacer-env-bench-"))
  await mkdir(path.join(top, ".git"))
  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const repository = path.join(top, "packages", `repository-${i}`)
      await mkdir(path.join(repository, ".git"), { recursive: true })
      await mkdir(path.join(repository, "src", "deep"), { recursive: true })
      await writeFile(path.join(repository, ".env"), `BUILD_REF=${i.toString(16).padStart(40, "0")}\nPORT=3000\n`)
      await writeFile(path.join(repository, ".env.local"), `TOKEN="local-token-${i}-0123456789"\n`)
      await writeFile(path.join(repository, ".env.example"), "TOKEN=\n")
      await writeFile(path.join(repository, "src", "deep", "index.ts"), "export {}\n")
    }),
  )
  return top
}

const results = [await measure("the folder given", root)]
const top = await madeUp(repositories)
results.push(await measure(`a repository of ${repositories} nested ones`, top))
await rm(top, { recursive: true, force: true })
const over = results.filter((result) => result.look.median > budget || result.added > budget)
if (over.length > 0) {
  console.error(`over the budget of ${budget} ms at the median: ${over.map((result) => result.label).join(", ")}`)
  process.exit(1)
}
