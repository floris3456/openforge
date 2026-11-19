import { describe, expect } from "bun:test"
import { ai } from "@opencode/ai/effect"
import { OpenAICompatibleResponses } from "@opencode/ai/providers"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerRoute } from "@opencode/core/pacer/route"
import { Effect, Stream } from "effect"
import { it } from "../lib/effect"

// Synthetic: no real address or key.
const key = "k-route"
const first = PacerEndpoint.normalize("https://a.cpp.invalid/cpp")!
const second = PacerEndpoint.normalize("https://b.cpp.invalid")!

/** CPP reached at `now` of `addresses`, set up at the first of them. */
const endpoints = (addresses: ReadonlyArray<PacerEndpoint.Address>, now: PacerEndpoint.Address) => {
  const home = PacerEndpoint.resolve({ baseURL: addresses[0]!.baseURL, apiKey: key }, undefined)!
  return PacerEndpoint.Service.of({
    get: () => Effect.succeed(now.root === home.root ? home : { ...home, ...now, home: home.root }),
    changes: () => Stream.never,
    addresses: () => Effect.succeed(addresses),
  })
}

const request = (baseURL: string, provider = "cliproxypacer") =>
  ai.request({
    model: OpenAICompatibleResponses.configure({ apiKey: key, baseURL, provider }).model("gpt-route-1"),
    prompt: "Hello",
  })

describe("PacerRoute.current", () => {
  it.effect("moves a request on one of CPP's addresses to the current one, keeping the path below its root", () =>
    Effect.gen(function* () {
      const moved = yield* PacerRoute.current(endpoints([first, second], second), request(first.baseURL))
      expect(moved.model.route.endpoint.baseURL).toBe(`${second.root}/v1`)
      expect(String(moved.model.id)).toBe("gpt-route-1")
      const back = yield* PacerRoute.current(endpoints([first, second], first), request(second.baseURL))
      expect(back.model.route.endpoint.baseURL).toBe(`${first.root}/v1`)
    }),
  )

  it.effect("leaves another provider, an address CPP did not name, the current address and one address alone", () =>
    Effect.gen(function* () {
      const pair = endpoints([first, second], second)
      for (const sent of [
        request(first.baseURL, "openai-compatible"),
        request("https://elsewhere.invalid/v1"),
        request(second.baseURL),
      ])
        expect(yield* PacerRoute.current(pair, sent)).toBe(sent)
      const alone = request(first.baseURL)
      expect(yield* PacerRoute.current(endpoints([first], first), alone)).toBe(alone)
    }),
  )
})
