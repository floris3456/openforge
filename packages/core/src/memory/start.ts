export * as MemoryStart from "./start.js"

import { and, desc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerModels } from "../pacer/models.js"
import { SessionEvent } from "../session/event.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable } from "../session/sql.js"
import { MemoryClient } from "./client.js"
import { MemoryText } from "./text.js"

// The start block (the workspace's spec `docs/specs/memory.md`, section 3): one durable synthetic message per span of
// a chat the model sees, put in at the step boundary before the step's request is built. As with file instructions
// (`SessionInstructions`), the message's metadata is the only ledger: a block that a compaction or a revert took out
// of view is built again, from the chat's newest prompt. It is stored, so every step of the span sends the same bytes.

/** How long the start call may take before the chat goes on without it. */
const TIMEOUT = "2 seconds"
/** How many entries the block holds at most. */
const LIMIT = 5

export interface Interface {
  /** Puts a start block in the chat when none is in view. Never fails, and waits at most {@link TIMEOUT} for memory. */
  readonly ensure: (input: {
    readonly session: SessionSchema.Info
    /** The agent the chat runs as: its role. */
    readonly agent: string
    /** Whether the chat has the `recall` tool, which the block then names. */
    readonly recall: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryStart") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const config = yield* Config.Service
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    const client = yield* MemoryClient.Service

    const ensure = Effect.fn("MemoryStart.ensure")(function* (input: Parameters<Interface["ensure"]>[0]) {
      if ((yield* endpoints.get()) === undefined) return
      // An unread catalog may yet say memory is there: the next boundary tries again.
      if (!(yield* catalogs.get())?.pacer?.memory) return
      const sessionID = input.session.id
      const last = yield* newestBlock(sessionID)
      if (last?.visible) return
      const project = MemoryClient.project(yield* config.entries(), input.session.projectID)
      if (project === undefined) return
      const prompt = yield* newestPrompt(sessionID)
      if (!prompt) return
      const by = { role: input.agent, chat: sessionID }
      const block = yield* client
        .start(
          project,
          // Cut as the server counts, in code points.
          {
            prompt: [...prompt].slice(0, 2_000).join(""),
            scopes: { global: true, roles: [by.role] },
            limit: LIMIT,
            by,
          },
          { timeout: TIMEOUT },
        )
        .pipe(
          Effect.map((started) => ({
            text: MemoryText.block(started, by.role, input.recall),
            description: "Memory nearest to the prompt",
            memory: { project, recall: started.recall, entries: started.entries.map((entry) => entry.id) },
          })),
          Effect.catch((error) =>
            Effect.logWarning("memory's start block could not be read", { reason: error.message }).pipe(
              // A chat that had a block before keeps it: after a compaction its message is still stored. A revert deletes
              // the messages it takes back, the block among them, so a failure right after one gives the one line.
              Effect.as({
                text: last?.text ?? MemoryText.unavailable,
                description: last ? "Memory as before" : "Memory unavailable",
                memory: { project, unavailable: true },
              }),
            ),
          ),
        )
      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID,
        text: block.text,
        description: block.description,
        metadata: { memory: block.memory },
      })
    })

    /**
     * The chat's newest start block, and whether it is in the model's view: after the latest completed compaction,
     * which `SessionHistory.load` starts from. Two lookups on the session's type index, decoding no message.
     */
    const newestBlock = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const block = yield* db
        .select({
          seq: SessionMessageTable.seq,
          text: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.text')`,
        })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "synthetic"),
            sql`json_extract(${SessionMessageTable.data}, '$.metadata.memory') is not null`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!block) return undefined
      const compaction = yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return {
        visible: compaction === undefined || block.seq > compaction.seq,
        text: typeof block.text === "string" ? block.text : undefined,
      }
    })

    const newestPrompt = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select({ text: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.text')` })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return typeof row?.text === "string" ? row.text : undefined
    })

    return Service.of({
      // The block is a help, never a condition of the step: a defect here is logged and the step goes on.
      ensure: (input) =>
        ensure(input).pipe(
          Effect.catchDefect((defect) => Effect.logWarning("memory's start block failed", { defect: String(defect) })),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, Config.node, PacerEndpoint.node, PacerModels.node, MemoryClient.node],
})
