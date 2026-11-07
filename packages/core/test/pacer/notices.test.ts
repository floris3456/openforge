import { describe, expect } from "bun:test"
import { Clock, Context, Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Pacer } from "@opencode/schema/pacer"
import type { SessionID } from "@opencode/schema/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { PacerNotices } from "@opencode/core/pacer/notices"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import type { PacerWire } from "@opencode/core/pacer/wire"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { globalProjectNode } from "../lib/project"

// The cache notices (spec cliproxypacer-cache-notices, sections 1 and 2), given CPP's request rows as the connection
// reads them, over the real bus and session store. The connection's own reads are tested in connection.test.ts. Every
// row is synthetic. The clock is TestClock's: the notices start at 0, and CPP's times are those of the rows.

const it = testEffect(Layer.empty)

const HOUR = 3_600_000

const setup = Effect.fnUntraced(function* () {
  const folder = yield* tmpdirScoped("opencode-pacer-notices-")
  const context = yield* Layer.build(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionProjector.node,
        SessionStore.node,
        SessionInbox.node,
        Session.node,
      ]),
      [
        Project.node.replace(globalProjectNode),
        SessionExecution.node.replace(
          Layer.succeed(
            SessionExecution.Service,
            SessionExecution.Service.of({
              active: Effect.sync(() => new Set<SessionID>()),
              isActive: () => Effect.succeed(false),
              resume: () => Effect.void,
              wake: () => Effect.void,
              interrupt: () => Effect.succeed(false),
              awaitIdle: () => Effect.void,
            }),
          ),
        ),
      ],
    ),
  )
  const bus = Context.get(context, Bus.Service)
  const sessions = Context.get(context, Session.Service)
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  yield* bus.subscribe([Pacer.Event.NoticeAdded, Pacer.Event.NoticeDismissed]).pipe(
    Stream.runForEach((event) => Effect.sync(() => void published.push({ type: event.type, data: event.data }))),
    Effect.forkScoped({ startImmediately: true }),
  )
  const notices = yield* PacerNotices.make.pipe(
    Effect.provideService(Bus.Service, bus),
    Effect.provideService(Session.Service, sessions),
  )
  const location = Location.Ref.make({ directory: AbsolutePath.make(folder.path) })
  // The chats the connection holds, by CPP's UUID.
  const held = new Map<string, SessionID>()
  return {
    notices,
    sessions,
    published,
    held,
    /** A chat of this service, held by the connection unless `held` is false. */
    chat: Effect.fnUntraced(function* (
      input: { readonly parentID?: SessionID; readonly title?: string; readonly agent?: string } = {},
      hold = true,
    ) {
      const fields = {
        ...(input.title ? { title: input.title } : {}),
        ...(input.agent ? { agent: Agent.ID.make(input.agent) } : {}),
      }
      const info = yield* input.parentID
        ? sessions.create({ parentID: input.parentID, ...fields })
        : sessions.create({ location, ...fields })
      if (hold) held.set(PacerSessionID.make(info.id), info.id)
      return info.id
    }),
    /** Gives the notices rows as the connection does after a read. */
    read: (rows: ReadonlyArray<PacerWire.Row>) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        notices.read(rows, (uuid) => held.get(uuid), { offset: 0, now }),
      ),
    list: () => notices.list(),
    added: () =>
      published.flatMap((event) =>
        event.type === "pacer.notice.added" ? [(event.data as { notice: Pacer.Notice }).notice.requestID] : [],
      ),
    dismissed: () =>
      published.flatMap((event) =>
        event.type === "pacer.notice.dismissed" ? [(event.data as { requestID: string }).requestID] : [],
      ),
  }
})

/** Lets the bus deliver what was published. */
const settle = TestClock.withLive(Effect.sleep("20 millis"))

/** A request row as CPP lists it: a step's miss of the chat `uuid` names, received at `1_000_000 + id`. */
function row(id: number, uuid: string | null, fields: Partial<PacerWire.Row> = {}): PacerWire.Row {
  return {
    id,
    at: 1_000_000 + id,
    ext: `req-${id}`,
    provider: "prova",
    model: "upstream-a",
    alias: "model-a",
    kind: 0,
    status: 200,
    failed: false,
    input: 10,
    output: 5,
    cache_read: 0,
    cache_write_5m: 1_000,
    cache_verdict: "miss",
    cache_cause: "prefix-changed",
    cache_shortfall: 1_000,
    miss_cost: null,
    changed_part: null,
    session_ext: uuid,
    subagent: false,
    account: "account-a",
    ...fields,
  }
}

const KINDS = { step: 0, ping: 1, title: 2, compaction: 3, other: 4, probe: 5, search: 6 }

describe("PacerNotices", () => {
  it.effect(
    "raises a notice for each miss or partial reuse of a step or a compaction of a chat it names, and for no other row",
    () =>
      Effect.gen(function* () {
        const h = yield* setup()
        const parent = yield* h.chat()
        const child = yield* h.chat({ parentID: parent })
        const chat = PacerSessionID.make(parent)
        const subagent = PacerSessionID.make(child)
        const rows = [
          // Each kind's miss: only a step's and a compaction's count.
          ...Object.values(KINDS).map((kind, index) => row(1 + index, chat, { kind })),
          // Each verdict of a step and of a compaction: only miss and partial count.
          ...["partial", "hit", "shared", "cold", "unreported", null].flatMap((verdict, index) => [
            row(10 + index * 2, chat, { cache_verdict: verdict }),
            row(11 + index * 2, chat, { kind: KINDS.compaction, cache_verdict: verdict }),
          ]),
          // A failed step has no verdict.
          row(30, chat, { failed: true, status: 500, cache_verdict: null }),
          // A subagent's step; CPP names a UUID as it was sent, in any case.
          row(31, subagent.toUpperCase(), { subagent: true }),
          // Another client's chat on the same key, and a row of no chat.
          row(32, "another-client-chat"),
          row(33, null),
        ]
        yield* h.read(rows)
        yield* settle

        expect((yield* h.list()).map((notice) => notice.requestID)).toEqual([
          "req-31",
          "req-11",
          "req-10",
          "req-4",
          "req-1",
        ])
        expect((yield* h.list()).map((notice) => [notice.sessionID, notice.verdict])).toEqual([
          [child, "miss"],
          [parent, "partial"],
          [parent, "partial"],
          [parent, "miss"],
          [parent, "miss"],
        ])
        // One event each, oldest first.
        expect(h.added()).toEqual(["req-1", "req-4", "req-10", "req-11", "req-31"])
      }),
  )

  it.effect(
    "raises none for the losses that are expected, CLIProxyPacer's causes expired and compaction, and one for every other cause or none",
    () =>
      Effect.gen(function* () {
        const h = yield* setup()
        const parent = yield* h.chat()
        const child = yield* h.chat({ parentID: parent })
        const chat = PacerSessionID.make(parent)
        const subagent = PacerSessionID.make(child)
        // The chat not held yet: its expected losses don't wait either.
        const early = yield* h.chat({}, false)
        const waiting = PacerSessionID.make(early)
        yield* h.read([
          // The cache ran out, or a summary replaced the prompt: of a step, a summary, a subagent's step, as a miss or a
          // partial reuse.
          row(1, chat, { cache_cause: "expired", cache_shortfall: 40_000 }),
          row(2, chat, { cache_cause: "compaction", cache_shortfall: 40_000 }),
          row(3, chat, { cache_verdict: "partial", cache_cause: "compaction" }),
          row(4, chat, { kind: KINDS.compaction, cache_cause: "expired" }),
          row(5, subagent, { subagent: true, cache_cause: "expired" }),
          row(6, waiting, { cache_cause: "compaction" }),
          // Every other cause of CLIProxyPacer's (crates/cpa-pacer/src/cache.rs, Verdict), and none.
          row(7, chat, { cache_cause: "prefix-changed", changed_part: "tools[0]" }),
          row(8, chat, { cache_cause: "account-changed" }),
          row(9, chat, { cache_cause: "model-changed" }),
          row(10, chat, { cache_cause: "lifetime-changed", changed_part: "system" }),
          row(11, chat, { cache_cause: "server-layout", changed_part: "messages[2]" }),
          row(12, chat, { cache_cause: "provider" }),
          row(13, chat, { cache_cause: "unknown" }),
          row(14, chat, { cache_cause: null }),
          row(15, subagent, { subagent: true, cache_verdict: "partial", cache_cause: "account-changed" }),
          row(16, waiting, { cache_cause: "prefix-changed", changed_part: "system" }),
        ])
        yield* h.notices.named(waiting, early)
        yield* settle

        expect((yield* h.list()).map((notice) => [notice.requestID, notice.cause])).toEqual([
          ["req-16", "prefix-changed · system"],
          ["req-15", "account-changed"],
          ["req-14", "unknown cause"],
          ["req-13", "unknown"],
          ["req-12", "provider"],
          ["req-11", "server-layout · messages[2]"],
          ["req-10", "lifetime-changed · system"],
          ["req-9", "model-changed"],
          ["req-8", "account-changed"],
          ["req-7", "prefix-changed · tools[0]"],
        ])
        expect(h.added()).toEqual([
          "req-7",
          "req-8",
          "req-9",
          "req-10",
          "req-11",
          "req-12",
          "req-13",
          "req-14",
          "req-15",
          "req-16",
        ])
      }),
  )

  it.effect(
    "shapes a notice: the tokens written again, the cause as the Requests tab says it, the chat's title and agent, its top chat",
    () =>
      Effect.gen(function* () {
        const h = yield* setup()
        const root = yield* h.chat({ title: "A chat", agent: "build" })
        // A subagent's subagent whose parent this service doesn't hold: its top chat comes from the store.
        const middle = yield* h.chat({ parentID: root, title: "Middle", agent: "general" }, false)
        const leaf = yield* h.chat({ parentID: middle, title: "Leaf", agent: "explore" })
        const gone = yield* h.chat({ title: "Gone" })
        yield* h.sessions.remove(gone)
        yield* h.read([
          row(1, PacerSessionID.make(leaf), {
            subagent: true,
            cache_cause: "prefix-changed",
            changed_part: "tools",
            cache_shortfall: 152_000,
            miss_cost: 7_065_600,
          }),
          // No count, no cause, no cost.
          row(2, PacerSessionID.make(root), { cache_cause: null, cache_shortfall: 0 }),
          row(3, PacerSessionID.make(root), {
            cache_verdict: "partial",
            cache_cause: null,
            changed_part: "system",
            cache_shortfall: null,
            alias: null,
            model: "upstream-b",
          }),
          // A chat gone from the store is no longer one of this service's.
          row(4, PacerSessionID.make(gone)),
        ])
        yield* settle

        expect(yield* h.list()).toEqual([
          {
            requestID: "req-3",
            sessionID: root,
            rootID: root,
            title: "A chat",
            agent: Agent.ID.make("build"),
            model: "upstream-b",
            verdict: "partial",
            cause: "system",
            at: 1_000_003,
          },
          {
            requestID: "req-2",
            sessionID: root,
            rootID: root,
            title: "A chat",
            agent: Agent.ID.make("build"),
            model: "model-a",
            verdict: "miss",
            cause: "unknown cause",
            at: 1_000_002,
          },
          {
            requestID: "req-1",
            sessionID: leaf,
            rootID: root,
            title: "Leaf",
            agent: Agent.ID.make("explore"),
            model: "model-a",
            verdict: "miss",
            tokens: 152_000,
            cause: "prefix-changed · tools",
            missCost: Money.USD.make(0.0070656),
            at: 1_000_001,
          },
        ])
        // The event carries the notice as listed.
        expect(h.published[0]).toEqual({ type: "pacer.notice.added", data: { notice: (yield* h.list())[2] } })
        // A chat without a title or an agent leaves them out.
        const bare = yield* h.chat()
        yield* h.read([row(5, PacerSessionID.make(bare))])
        expect(Object.keys((yield* h.list())[0]).toSorted()).toEqual([
          "at",
          "cause",
          "model",
          "requestID",
          "rootID",
          "sessionID",
          "tokens",
          "verdict",
        ])
      }),
  )

  it.effect(
    "holds at most 50, newest first, the dismissed ones counted; one older than all of them raises nothing",
    () =>
      Effect.gen(function* () {
        const h = yield* setup()
        const uuid = PacerSessionID.make(yield* h.chat())
        yield* h.read(Array.from({ length: 30 }, (_, index) => row(1 + index, uuid)))
        yield* h.notices.dismiss("req-30")
        yield* h.read(Array.from({ length: 25 }, (_, index) => row(31 + index, uuid)))
        yield* settle

        const listed = (yield* h.list()).map((notice) => notice.requestID)
        // 50 held: req-55 down to req-6, req-30 among them, dismissed.
        expect(listed).toHaveLength(49)
        expect(listed[0]).toBe("req-55")
        expect(listed.at(-1)).toBe("req-6")
        expect(listed).not.toContain("req-30")
        expect(h.added()).toHaveLength(55)

        // Received before the oldest held: it would go at once, so it is not told.
        yield* h.read([row(56, uuid, { at: 1_000_003 })])
        yield* settle
        expect(h.added()).toHaveLength(55)
        expect((yield* h.list()).map((notice) => notice.requestID)).toEqual(listed)
      }),
  )

  it.effect("holds none older than 2 hours, nor one CPP received before the service started", () =>
    Effect.gen(function* () {
      // The service starts 3 hours on.
      yield* TestClock.adjust(3 * HOUR)
      const h = yield* setup()
      const uuid = PacerSessionID.make(yield* h.chat())
      const start = yield* Clock.currentTimeMillis
      yield* h.read([row(1, uuid, { at: start - 60_000 }), row(2, uuid, { at: start + 1_000 })])
      yield* settle
      expect((yield* h.list()).map((notice) => notice.requestID)).toEqual(["req-2"])
      expect(h.added()).toEqual(["req-2"])

      // 2 hours after it, it goes; a row as old raises none, one a second younger does.
      yield* TestClock.adjust(2 * HOUR + 1_001)
      expect(yield* h.list()).toEqual([])
      yield* h.read([row(3, uuid, { at: start + 1_000 }), row(4, uuid, { at: start + 2_002 })])
      yield* settle
      expect((yield* h.list()).map((notice) => notice.requestID)).toEqual(["req-4"])
      expect(h.added()).toEqual(["req-2", "req-4"])
    }),
  )

  it.effect("dismisses a notice in every TUI once; the same row read again raises nothing", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const uuid = PacerSessionID.make(yield* h.chat())
      yield* h.read([row(1, uuid), row(2, uuid)])
      yield* h.notices.dismiss("req-1")
      yield* settle
      expect((yield* h.list()).map((notice) => notice.requestID)).toEqual(["req-2"])
      expect(h.dismissed()).toEqual(["req-1"])

      // Again: told once.
      yield* h.notices.dismiss("req-1")
      // Read again (another CPP's first read lists it again): neither back nor told again.
      yield* h.read([row(1, uuid)])
      yield* settle
      expect(h.dismissed()).toEqual(["req-1"])
      expect(h.added()).toEqual(["req-1", "req-2"])
      expect((yield* h.list()).map((notice) => notice.requestID)).toEqual(["req-2"])

      // A request with no notice held is told, so that a TUI still showing one drops it.
      yield* h.notices.dismiss("req-unknown")
      yield* settle
      expect(h.dismissed()).toEqual(["req-1", "req-unknown"])
    }),
  )

  it.effect("keeps a row of a chat not held yet until the chat is, the newest 50, within the lifetime", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const early = yield* h.chat({}, false)
      const uuid = PacerSessionID.make(early)
      // 51 rows before the chat is held: the oldest goes.
      yield* h.read(Array.from({ length: 51 }, (_, index) => row(1 + index, uuid)))
      yield* settle
      expect(yield* h.list()).toEqual([])
      expect(h.added()).toEqual([])

      yield* h.notices.named(uuid, early)
      yield* settle
      expect(h.added()).toEqual(Array.from({ length: 50 }, (_, index) => `req-${2 + index}`))
      expect(yield* h.list()).toHaveLength(50)
      expect((yield* h.list()).every((notice) => notice.sessionID === early)).toBe(true)
      // Named again: nothing waits.
      yield* h.notices.named(uuid, early)
      yield* settle
      expect(h.added()).toHaveLength(50)

      // One that waited longer than the lifetime raises none.
      const late = yield* h.chat({}, false)
      const lateUUID = PacerSessionID.make(late)
      yield* h.read([row(60, lateUUID)])
      yield* TestClock.adjust(1_000_060 + 2 * HOUR + 1)
      yield* h.notices.named(lateUUID, late)
      yield* settle
      expect(h.added()).toHaveLength(50)
    }),
  )
})
