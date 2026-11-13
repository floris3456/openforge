import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerTools } from "@opencode/core/pacer/tools"
import { SessionEvent } from "@opencode/core/session/event"
import { testEffect } from "../lib/effect"
import {
  catalogOf,
  endpointOf,
  fakeCpp,
  listOf,
  only,
  ownerClaude,
  ownerList,
  settle,
  startTools,
  until,
} from "./fake-tools"

const it = testEffect(Layer.empty)

const chat = SessionID.make("ses_web_tools_chat")
const child = SessionID.make("ses_web_tools_child")
const other = SessionID.make("ses_web_tools_other")
const step = (sessionID: SessionID, model = "claude-haiku-5-5", parentID?: SessionID): PacerTools.ListInput => ({
  sessionID,
  ...(parentID ? { parentID } : {}),
  model,
  step: true,
})
const compaction = (sessionID: SessionID, model = "claude-haiku-5-5"): PacerTools.ListInput => ({
  ...step(sessionID, model),
  step: false,
})
const ended = (sessionID: SessionID) =>
  [
    SessionEvent.Compaction.Ended,
    {
      sessionID,
      reason: "auto" as const,
      model: { id: Model.ID.make("claude-haiku-5-5"), providerID: Provider.ID.make("cliproxypacer") },
      text: "summary",
    },
  ] as const
/** The definitions as the claude shape writes them, to compare with CPP's bytes. */
const claude = (list: PacerTools.List | undefined) =>
  JSON.stringify(
    list?.definitions.map((item) => ({
      name: item.name,
      description: item.description,
      input_schema: item.inputSchema,
    })),
  )

describe("PacerTools.list", () => {
  it.effect("reads the chat's list at its first request, with the chat's headers and model, and then holds it", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))

      const first = yield* tools.list(step(child, "claude-haiku-5-5", chat))
      expect(cpp.lists()).toHaveLength(1)
      const read = cpp.lists()[0]!
      expect(read.method).toBe("GET")
      expect(read.query.get("model")).toBe("claude-haiku-5-5")
      expect(read.headers.get("authorization")).toBe("Bearer client-key-test")
      expect(read.headers.get("x-pacer-session")).toBe(PacerSessionID.make(child))
      expect(read.headers.get("x-pacer-parent-session")).toBe(PacerSessionID.make(chat))
      expect(read.headers.get("x-pacer-kind")).toBeNull()
      expect(first?.version).toBe(ownerList.version)
      expect(first?.definitions.map((item) => item.name)).toEqual([
        "web_search",
        "web_extract",
        "web_crawl",
        "web_research",
      ])
      // Name, description and schema as CPP wrote them, byte for byte.
      expect(claude(first)).toBe(ownerClaude)

      // The same objects on every request until the list is read again.
      const again = yield* tools.list(step(child, "claude-haiku-5-5", chat))
      expect(again).toBe(first!)
      expect(cpp.lists()).toHaveLength(1)
    }),
  )

  it.effect("reads it again when the step's model changes, not for a compaction or generation on another model", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      const first = yield* tools.list(step(chat, "claude-haiku-5-5"))

      // A compaction on a cheaper model carries the steps' list, so its prompt starts as theirs.
      expect(yield* tools.list(compaction(chat, "gpt-6-luna"))).toBe(first!)
      expect(cpp.lists()).toHaveLength(1)

      yield* tools.list(step(chat, "gpt-6-luna"))
      expect(cpp.lists().map((item) => item.query.get("model"))).toEqual(["claude-haiku-5-5", "gpt-6-luna"])
      yield* tools.list(step(chat, "gpt-6-luna"))
      expect(cpp.lists()).toHaveLength(2)
    }),
  )

  it.effect("reads it for a compaction or generation only when the chat holds none", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      expect((yield* tools.list(compaction(chat)))?.version).toBe(ownerList.version)
      expect(cpp.lists()).toHaveLength(1)
      yield* tools.list(step(chat))
      expect(cpp.lists()).toHaveLength(1)
    }),
  )

  it.effect("reads it again at the step after the chat's compaction ends, also when it ends during that read", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools, bus } = yield* startTools(endpointOf(cpp.origin))
      yield* tools.list(step(chat))

      yield* bus.publish(...ended(chat))
      yield* settle
      // The compaction's own request still carries the list it summarizes with.
      yield* tools.list(compaction(chat))
      expect(cpp.lists()).toHaveLength(1)
      yield* tools.list(step(chat))
      expect(cpp.lists()).toHaveLength(2)

      // A compaction that ends while the list is read: the answer may be CPP's copy from before it.
      yield* bus.publish(...ended(chat))
      yield* settle
      cpp.hold()
      const reading = yield* tools.list(step(chat)).pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the third read", () => cpp.lists().length === 3)
      yield* bus.publish(...ended(chat))
      yield* settle
      cpp.gate.release()
      expect((yield* Fiber.join(reading))?.version).toBe(ownerList.version)
      yield* tools.list(step(chat))
      expect(cpp.lists()).toHaveLength(4)
      yield* tools.list(step(chat))
      expect(cpp.lists()).toHaveLength(4)
    }),
  )

  it.effect("reads it again when a model answer's X-Pacer-Tools names another version, not the same or none", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      yield* tools.list(step(chat))

      tools.seen(chat, ownerList.version)
      tools.seen(chat, undefined)
      yield* tools.list(step(chat))
      expect(cpp.lists()).toHaveLength(1)

      tools.seen(chat, "0123456789abcdef")
      yield* tools.list(compaction(chat))
      expect(cpp.lists()).toHaveLength(1)
      yield* tools.list(step(chat))
      expect(cpp.lists()).toHaveLength(2)
      // A chat it holds nothing for reads at its first request anyway.
      tools.seen(other, "0123456789abcdef")
      yield* tools.list(step(chat))
      expect(cpp.lists()).toHaveLength(2)
    }),
  )

  it.effect("shares one read among the chat's requests that need it at once", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      cpp.hold()
      const first = yield* tools.list(step(chat)).pipe(Effect.forkChild({ startImmediately: true }))
      const second = yield* tools.list(compaction(chat)).pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the read", () => cpp.lists().length === 1)
      yield* settle
      expect(cpp.lists()).toHaveLength(1)
      cpp.gate.release()
      const lists = [yield* Fiber.join(first), yield* Fiber.join(second)]
      expect(lists[0]?.version).toBe(ownerList.version)
      expect(lists[1]).toBe(lists[0]!)
    }),
  )

  it.effect("waits at most 5 s for a read, then goes without the list and reads no held list again for 30 s", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      const held = yield* tools.list(step(other))
      tools.seen(other, "0123456789abcdef")
      cpp.hold()
      const reading = yield* tools.list(step(chat)).pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the read", () => cpp.lists().length === 2)
      yield* TestClock.adjust("4999 millis")
      yield* settle
      expect(reading.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 millis")
      expect(yield* Fiber.join(reading)).toBeUndefined()
      cpp.gate.release()

      // A held list is not read again during the pause.
      expect(yield* tools.list(step(other))).toBe(held!)
      yield* TestClock.adjust("29999 millis")
      expect(yield* tools.list(step(other))).toBe(held!)
      expect(cpp.lists()).toHaveLength(2)
      yield* TestClock.adjust("1 millis")
      yield* tools.list(step(other))
      expect(cpp.lists()).toHaveLength(3)
    }),
  )

  it.effect("reads the list of a chat that holds none during the pause, as every chat's right after a restart", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin), undefined)
      cpp.answers.list = () =>
        Response.json({ error: { type: "busy", message: "every store turn busy" } }, { status: 503 })
      expect(yield* tools.list(step(chat))).toBeUndefined()

      cpp.answers.list = () => Response.json(ownerList)
      expect((yield* tools.list(step(other)))?.version).toBe(ownerList.version)
      // The chat whose read failed holds none either: its next request reads again.
      expect((yield* tools.list(step(chat)))?.version).toBe(ownerList.version)
      expect(cpp.lists().map((read) => read.headers.get("x-pacer-session"))).toEqual([
        PacerSessionID.make(chat),
        PacerSessionID.make(other),
        PacerSessionID.make(chat),
      ])
    }),
  )

  it.effect("keeps a held list through a failed read", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      const held = yield* tools.list(step(chat))
      cpp.answers.list = () =>
        Response.json({ error: { type: "busy", message: "every store turn busy" } }, { status: 503 })
      tools.seen(chat, "0123456789abcdef")
      expect(yield* tools.list(step(chat))).toBe(held!)
      expect(cpp.lists()).toHaveLength(2)
      // And through the pause; a read that does not decode is a failure too.
      expect(yield* tools.list(step(chat))).toBe(held!)
      expect(cpp.lists()).toHaveLength(2)
      cpp.answers.list = () => Response.json({ version: 7 })
      yield* TestClock.adjust("30 seconds")
      expect(yield* tools.list(step(chat))).toBe(held!)
      expect(cpp.lists()).toHaveLength(3)
    }),
  )

  it.effect("holds the last 1000 chats, and reads a chat pushed out again at its next request", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      cpp.answers.list = () => Response.json(listOf("00000000000000aa", only("web_search")))
      const id = (index: number) => SessionID.make(`ses_web_tools_lru_${index}`)
      for (let index = 0; index <= PacerTools.CHATS; index++) yield* tools.list(step(id(index)))
      expect(cpp.lists()).toHaveLength(PacerTools.CHATS + 1)

      // The first chat was pushed out by the 1001st; a chat used again moves to the end.
      yield* tools.list(step(id(1)))
      expect(cpp.lists()).toHaveLength(PacerTools.CHATS + 1)
      yield* tools.list(step(id(0)))
      expect(cpp.lists()).toHaveLength(PacerTools.CHATS + 2)
      // That pushed out the least recently used one, id(2), not id(1).
      yield* tools.list(step(id(1)))
      expect(cpp.lists()).toHaveLength(PacerTools.CHATS + 2)
      yield* tools.list(step(id(2)))
      expect(cpp.lists()).toHaveLength(PacerTools.CHATS + 3)
    }),
  )

  it.effect("makes one list per version, shared by its chats, and forgets a version no chat holds", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      const a = yield* tools.list(step(chat))
      const b = yield* tools.list(step(other))
      expect(cpp.lists()).toHaveLength(2)
      expect(b).toBe(a!)

      cpp.answers.list = () => Response.json(listOf("00000000000000bb", only("web_search")))
      tools.seen(chat, "00000000000000bb")
      tools.seen(other, "00000000000000bb")
      const next = yield* tools.list(step(chat))
      expect(yield* tools.list(step(other))).toBe(next!)
      expect(next?.definitions.map((item) => item.name)).toEqual(["web_search"])

      // No chat holds the first version now: reading it again makes it anew.
      cpp.answers.list = () => Response.json(ownerList)
      tools.seen(chat, ownerList.version)
      const back = yield* tools.list(step(chat))
      expect(back).not.toBe(a!)
      expect(claude(back)).toBe(claude(a))
    }),
  )

  it.effect("starts over when the endpoint changes, and drops a read of the old one", () =>
    Effect.gen(function* () {
      const first = yield* fakeCpp
      const second = yield* fakeCpp
      const { tools, endpoints } = yield* startTools(endpointOf(first.origin))
      yield* tools.list(step(chat))
      expect(first.lists()).toHaveLength(1)

      yield* SubscriptionRef.set(endpoints, endpointOf(second.origin))
      yield* settle
      yield* tools.list(step(chat))
      expect(second.lists()).toHaveLength(1)

      second.hold()
      const reading = yield* tools.list(step(other)).pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the read", () => second.lists().length === 2)
      // The same server with another key is another client: what the old one read is not its.
      yield* SubscriptionRef.set(endpoints, endpointOf(second.origin, "client-key-other"))
      yield* settle
      second.gate.release()
      expect(yield* Fiber.join(reading)).toBeUndefined()
      yield* tools.list(step(other))
      yield* tools.list(step(chat))
      expect(second.lists().map((item) => item.headers.get("authorization"))).toEqual([
        "Bearer client-key-test",
        "Bearer client-key-test",
        "Bearer client-key-other",
        "Bearer client-key-other",
      ])
    }),
  )

  it.effect("reads nothing without an endpoint, or while the catalog says the server has no web tools", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools, catalogs, endpoints } = yield* startTools(endpointOf(cpp.origin), catalogOf(false))
      expect(yield* tools.list(step(chat))).toBeUndefined()
      yield* SubscriptionRef.set(catalogs, catalogOf("no pacer"))
      expect(yield* tools.list(step(chat))).toBeUndefined()
      expect(cpp.lists()).toHaveLength(0)

      // A catalog not read yet, as right after a restart, reads anyway.
      yield* SubscriptionRef.set(catalogs, undefined)
      expect((yield* tools.list(step(chat)))?.version).toBe(ownerList.version)
      yield* SubscriptionRef.set(catalogs, catalogOf(true))
      yield* SubscriptionRef.set(endpoints, undefined)
      yield* settle
      expect(yield* tools.list(step(other))).toBeUndefined()
      expect(cpp.lists()).toHaveLength(1)
    }),
  )

  it.effect("takes a 404 for no web tools at this endpoint, until the catalog changes", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools, catalogs } = yield* startTools(endpointOf(cpp.origin), undefined)
      cpp.answers.list = () => new Response("404 page not found", { status: 404 })
      expect(yield* tools.list(step(chat))).toBeUndefined()
      expect(yield* tools.list(step(other))).toBeUndefined()
      expect(cpp.lists()).toHaveLength(1)

      cpp.answers.list = () => Response.json(ownerList)
      yield* SubscriptionRef.set(catalogs, catalogOf(true))
      yield* settle
      expect((yield* tools.list(step(other)))?.version).toBe(ownerList.version)
      expect(cpp.lists()).toHaveLength(2)
    }),
  )

  it.effect("forgets a deleted chat", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools, bus } = yield* startTools(endpointOf(cpp.origin))
      yield* tools.list(step(chat))
      yield* bus.publish(SessionEvent.Deleted, { sessionID: chat })
      yield* settle
      yield* tools.list(step(chat))
      expect(cpp.lists()).toHaveLength(2)
    }),
  )
})

describe("PacerTools.call", () => {
  it.effect(
    "posts the model's arguments unchanged with the chat's headers, and answers CPP's text, data and error",
    () =>
      Effect.gen(function* () {
        const cpp = yield* fakeCpp
        const { tools } = yield* startTools(endpointOf(cpp.origin))
        const args = { query: "rust 1.95 «release» notes", max_results: 5, include_domains: ["blog.rust-lang.org"] }

        const answer = yield* tools.call({ sessionID: child, parentID: chat, name: "web_search", args })
        expect(answer).toEqual({
          text: "answered /pacer/v1/tools/web_search",
          data: { tool: "web_search", provider: "tavily", cost_nano_usd: 8_000_000 },
        })
        const sent = cpp.calls()[0]!
        expect(sent.method).toBe("POST")
        expect(sent.body).toBe(JSON.stringify(args))
        expect(sent.headers.get("authorization")).toBe("Bearer client-key-test")
        expect(sent.headers.get("x-pacer-session")).toBe(PacerSessionID.make(child))
        expect(sent.headers.get("x-pacer-parent-session")).toBe(PacerSessionID.make(chat))

        // A failed call is still a 200.
        cpp.answers.call = () =>
          Response.json({
            text: "Web search failed: no search can serve this call now. Go on without it.",
            data: { tool: "web_search", rule: "search.default", attempts: [] },
            error: { code: "unavailable", message: "no search can serve this call now" },
          })
        expect(yield* tools.call({ sessionID: chat, name: "web_search", args })).toEqual({
          text: "Web search failed: no search can serve this call now. Go on without it.",
          data: { tool: "web_search", rule: "search.default", attempts: [] },
          error: { code: "unavailable", message: "no search can serve this call now" },
        })
        expect(cpp.calls()[1]?.headers.get("x-pacer-parent-session")).toBeNull()
      }),
  )

  it.effect("fails naming CPP's problems on a 400", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      cpp.answers.call = () =>
        Response.json(
          { error: { type: "invalid_request", message: "web_search has no colour; query is required" } },
          { status: 400 },
        )
      const error = yield* tools
        .call({ sessionID: chat, name: "web_search", args: { colour: "red" } })
        .pipe(Effect.flip)
      expect(error.reason).toBe("invalid")
      expect(error.message).toBe(
        "CLIProxyPacer refused the arguments of web_search: web_search has no colour; query is required",
      )
    }),
  )

  it.effect("fails on a 404, and the chat's list is read again at its next step", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      yield* tools.list(step(chat))
      cpp.answers.call = () =>
        Response.json({ error: { type: "not_found", message: "no tool web_crawl" } }, { status: 404 })
      const error = yield* tools
        .call({ sessionID: chat, name: "web_crawl", args: { url: "https://a.test" } })
        .pipe(Effect.flip)
      expect(error.reason).toBe("unknown")
      expect(error.message).toBe("CLIProxyPacer has no tool web_crawl")
      yield* tools.list(step(chat))
      expect(cpp.lists()).toHaveLength(2)
    }),
  )

  it.effect("fails saying CPP could not be reached when refused or unanswered for 2 minutes", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools, endpoints } = yield* startTools(endpointOf(cpp.origin))
      cpp.hold()
      const calling = yield* tools
        .call({ sessionID: chat, name: "web_research", args: { question: "q" } })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* until("the call", () => cpp.calls().length === 1)
      yield* TestClock.adjust("119999 millis")
      yield* settle
      expect(calling.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 millis")
      const timedOut = yield* Fiber.join(calling)
      expect(timedOut.reason).toBe("unreachable")
      expect(timedOut.message).toBe("CLIProxyPacer could not be reached: no answer within 2m")
      cpp.gate.release()

      // Nothing listens on the port of a server that stopped.
      const closed = cpp.origin
      yield* Effect.promise(() => cpp.server.stop(true))
      yield* SubscriptionRef.set(endpoints, endpointOf(closed, "client-key-closed"))
      const refused = yield* tools
        .call({ sessionID: chat, name: "web_search", args: { query: "q" } })
        .pipe(Effect.flip, TestClock.withLive)
      expect(refused.reason).toBe("unreachable")
      expect(refused.message).toStartWith("CLIProxyPacer could not be reached: ")
    }),
  )

  it.effect("stops the call when the chat is interrupted", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const { tools } = yield* startTools(endpointOf(cpp.origin))
      cpp.hold()
      const calling = yield* tools
        .call({ sessionID: chat, name: "web_crawl", args: { url: "https://a.test" } })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* until("the call", () => cpp.calls().length === 1)
      yield* Fiber.interrupt(calling)
      yield* until("the request closed", () => cpp.gate.aborted === 1)
      cpp.gate.release()
    }),
  )
})
