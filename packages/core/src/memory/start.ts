export * as MemoryStart from "./start.js"

import { and, desc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { KV } from "../kv.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import { SessionEvent } from "../session/event.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable } from "../session/sql.js"
import { MemoryClient } from "./client.js"
import { MemoryFollowed } from "./followed.js"
import { MemoryKnown } from "./known.js"
import { MemoryOffer } from "./offer.js"
import { MemoryPrompt } from "./prompt.js"
import { MemorySummary } from "./summary.js"
import { MemoryTask } from "./task.js"
import { MemoryText } from "./text.js"

// The start block (the workspace's spec `docs/specs/memory.md`, section 3): one durable synthetic message per span of
// a chat the model sees, put in at the step boundary before the step's request is built. As with file instructions
// (`SessionInstructions`), the message's metadata is the only ledger: a block that a compaction or a revert took out
// of view is built again, from the chat's newest prompt and, after a compaction on a server with `summary`, with the
// entries close to its summary (`MemorySummary`). It is stored, so every step of the span sends the same bytes.
// It goes in only where the chat's prompt cache is new anyway, before the span's first step: a chat that stepped
// without one gets none, nor the memory tools (`MemoryOffer`), until its next compaction. So does a chat whose project
// CPP keeps memory from (`MemoryClient.Closed`, workspace spec `docs/specs/cpp-projects.md`).

/** How long the start call may take before the chat goes on without it. */
const TIMEOUT = "2 seconds"
/** How long the start call may take when it carries a compaction's summary, which the server searches part by part. */
const SUMMARY_TIMEOUT = "5 seconds"
/** How many entries the block holds at most, on a server that answers no prompts (`MemoryPrompt`). */
const LIMIT = 5

export interface Interface {
  /**
   * Puts a start block in the chat when none is in view, then the entries close to each new prompt (`MemoryPrompt`).
   * Never fails, and waits at most {@link TIMEOUT} for memory, for each call.
   */
  readonly ensure: (input: {
    readonly session: SessionSchema.Info
    /** The agent the chat runs as: its role. */
    readonly agent: string
    /** Whether the chat has the `recall` tool, which the block then names. */
    readonly recall: boolean
    /** Whether the chat has the `remember` tool: the block then says that memory is its to keep true. */
    readonly remember: boolean
    /**
     * Whether the agent may use the `task` tool: when the server has tasks, inside a task the block then says what to
     * do with the task's state.
     */
    readonly task: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryStart") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const kv = yield* KV.Service
    const projects = yield* PacerProject.Service
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    const client = yield* MemoryClient.Service
    const prompts = yield* MemoryPrompt.Service
    // What followed a search is added beside the chat; built with the start block, it runs wherever chats run.
    yield* MemoryFollowed.Service

    const ensure = Effect.fn("MemoryStart.ensure")(function* (input: Parameters<Interface["ensure"]>[0]) {
      const endpoint = yield* endpoints.get()
      if (endpoint === undefined) return
      // Whether the server has memory before anything of the chat is looked up: on a server without it, a step costs
      // memory nothing.
      const catalog = yield* catalogs.get()
      // Not read yet, as right after a start: as the server was last known. Whether it has tasks is known only once
      // the catalog is read; till the chat's next compaction it has none.
      if (!(catalog ? catalog.pacer?.memory !== undefined : yield* MemoryKnown.read(kv, endpoint))) return
      const sessionID = input.session.id
      const last = yield* MemoryOffer.newestBlock(db, sessionID)
      if (last?.visible) return
      if (yield* MemoryOffer.stepped(db, sessionID)) return
      const tasks = catalog?.pacer?.memory?.tasks === true
      // A server that answers each prompt gives the block no entries: they come with the prompts.
      const limit = catalog?.pacer?.memory?.prompt === true ? 0 : LIMIT
      const chat = yield* projects.chat(input.session.projectID)
      const project = chat.project
      if (project === undefined) return
      const prompt = yield* newestPrompt(sessionID)
      if (!prompt) return
      const inside = MemoryTask.inside(input.session.metadata)
      const by = { role: input.agent, chat: sessionID, ...inside }
      const offered = { ...input, task: input.task && tasks }
      const memory = client.withHeaders(
        PacerHeaders.chat({ sessionID, parentID: input.session.parentID, project: chat.headers }),
      )
      const request = {
        // Cut as the server counts, in code points.
        prompt: [...prompt].slice(0, 2_000).join(""),
        scopes: { global: true, roles: [by.role], ...(inside ? { tasks: [inside.task] } : {}) },
        limit,
        ...inside,
        by,
      }
      // After a compaction, the entries close to its summary; a chat's first block has none to search.
      const compaction =
        limit === 0 && catalog?.pacer?.memory?.summary === true
          ? yield* MemoryOffer.newestCompaction(db, sessionID)
          : undefined
      const summary = compaction ? MemorySummary.parts(compaction.summary) : []
      const plain = memory.start(project, request, { timeout: TIMEOUT })
      const block = yield* (
        summary.length
          ? memory
              .start(
                project,
                { ...request, summary, exclude: yield* MemoryOffer.inView(db, sessionID) },
                { timeout: SUMMARY_TIMEOUT },
              )
              .pipe(
                Effect.map((started) => ({ started, summary: true })),
                // Without the summary's entries the block is built as it would be without a summary.
                Effect.catch((error) =>
                  error._tag === "MemoryClient.Closed"
                    ? Effect.fail(error)
                    : Effect.logInfo("memory gave no entries for the summary", { reason: error.message }).pipe(
                        Effect.andThen(plain),
                        Effect.map((started) => ({ started, summary: false })),
                      ),
                ),
              )
          : plain.pipe(Effect.map((started) => ({ started, summary: false })))
      ).pipe(
        Effect.map((answer) => ({
          text: MemoryText.block(answer.started, by.role, offered, inside !== undefined, answer.summary),
          description: answer.summary ? "Memory close to the summary" : "Memory nearest to the prompt",
          memory: {
            project,
            recall: answer.started.recall,
            entries: answer.started.entries.map((entry) => entry.id),
            // What the task part may show, so that a prompt's entries leave them out.
            shown: [...(answer.started.task?.entries ?? []), ...(answer.started.subtask?.entries ?? [])].map(
              (entry) => entry.id,
            ),
            tasks,
          },
        })),
        // CPP keeps the project's memory from this key: no block, so no memory tools, till the chat's next cold point.
        Effect.catchTag("MemoryClient.Closed", (closed) =>
          Effect.logInfo("memory is closed to this chat's project", {
            project,
            type: closed.type,
            name: closed.project,
            moved: closed.moved,
          }).pipe(Effect.as(undefined)),
        ),
        Effect.catch((error) =>
          Effect.logWarning("memory's start block could not be read", { reason: error.message }).pipe(
            // A chat that had a block before keeps it: after a compaction its message is still stored. A revert deletes
            // the messages it takes back, the block among them, so a failure right after one gives the one line.
            Effect.as({
              text: last?.text ?? MemoryText.unavailable,
              description: last ? "Memory as before" : "Memory unavailable",
              memory: { project, unavailable: true, tasks },
            }),
          ),
        ),
      )
      if (block === undefined) return
      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID,
        text: block.text,
        description: block.description,
        metadata: { memory: block.memory },
      })
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
          Effect.andThen(prompts.ask({ session: input.session, agent: input.agent })),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    Database.node,
    KV.node,
    PacerEndpoint.node,
    PacerModels.node,
    PacerProject.node,
    MemoryClient.node,
    MemoryFollowed.node,
    MemoryPrompt.node,
  ],
})
