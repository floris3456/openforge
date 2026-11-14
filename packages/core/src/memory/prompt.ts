export * as MemoryPrompt from "./prompt.js"

import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import { SessionEvent } from "../session/event.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable } from "../session/sql.js"
import { MemoryClient } from "./client.js"
import { MemoryOffer } from "./offer.js"
import { MemoryPromptTable } from "./prompt.sql.js"
import { MemoryTask } from "./task.js"
import { MemoryText } from "./text.js"

// Every prompt (the workspace's spec `docs/specs/memory.md`, section 3, "Every prompt"): when a person's prompt reaches
// a chat that has memory, CPP is asked once for the entries that match it closely, and those go in as a stored message
// right after it, before the step that answers it. Nothing earlier in the chat changes, so the prompt cache holds up
// to the prompt. No entries, a timeout, an error or memory closed put nothing in, and nothing says so. Each prompt is
// asked once: its message's metadata (`memoryPrompt.prompt`) records it, else a row of `memory_prompt`, so a restart
// or a step tried again does not ask again.

/** How long the call may take before the step goes on without it. */
const TIMEOUT = "2 seconds"
/** How many ids of entries in view are sent to be left out, the newest. */
const EXCLUDE = 100

export interface Interface {
  /** Asks memory for each prompt since the chat's last step that was not asked yet. Never fails. */
  readonly ask: (input: {
    readonly session: SessionSchema.Info
    /** The agent the chat runs as: its role. */
    readonly agent: string
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const projects = yield* PacerProject.Service
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    const client = yield* MemoryClient.Service

    const ask = Effect.fn("MemoryPrompt.ask")(function* (input: Parameters<Interface["ask"]>[0]) {
      // Whether the server answers prompts before anything of the chat is looked up: elsewhere a step costs nothing.
      if ((yield* endpoints.get()) === undefined) return
      if ((yield* catalogs.get())?.pacer?.memory?.prompt !== true) return
      const sessionID = input.session.id
      const prompts = yield* unasked(sessionID)
      if (!prompts.length) return
      // A chat has memory while its start block in view offers it; one built while memory was unreachable asks nothing.
      const block = yield* MemoryOffer.newestBlock(db, sessionID)
      if (!block?.visible || block.unavailable) return
      const chat = yield* projects.chat(input.session.projectID)
      const project = chat.project
      if (project === undefined) return
      const inside = MemoryTask.inside(input.session.metadata)
      const by = { role: input.agent, chat: sessionID, ...inside }
      const memory = client.withHeaders(
        PacerHeaders.chat({ sessionID, parentID: input.session.parentID, project: chat.headers }),
      )
      // One after another, so a prompt's entries are in view, and left out, for the next.
      yield* Effect.forEach(
        prompts,
        Effect.fnUntraced(function* (prompt) {
          // Cut as the server counts, in code points.
          const text = [...prompt.text].slice(0, 2_000).join("")
          const answer = text.trim()
            ? yield* memory
                .prompt(
                  project,
                  {
                    prompt: text,
                    scopes: { global: true, roles: [by.role], ...(inside ? { tasks: [inside.task] } : {}) },
                    exclude: yield* inView(sessionID),
                    by,
                  },
                  { timeout: TIMEOUT },
                )
                .pipe(
                  Effect.catch((error) =>
                    Effect.logInfo("memory gave no entries for the prompt", { reason: error.message }).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                )
            : undefined
          if (answer && answer.entries.length > 0)
            return yield* bus.publish(SessionEvent.Synthetic, {
              sessionID,
              text: MemoryText.prompt(answer.entries),
              description: "Memory close to the prompt",
              metadata: {
                memoryPrompt: {
                  project,
                  recall: answer.recall,
                  entries: answer.entries.map((entry) => entry.id),
                  prompt: prompt.id,
                },
              },
            })
          yield* db
            .insert(MemoryPromptTable)
            .values({
              message_id: prompt.id,
              session_id: sessionID,
              project,
              recall: answer?.recall ?? null,
              time_created: Date.now(),
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
        }),
        { discard: true },
      )
    })

    /**
     * The person's prompts after the chat's last step (and its latest compaction) that memory was not asked for: one
     * lookup when there are none, as at every step that answers no new prompt.
     */
    const unasked = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const prompts = yield* db
        .select({
          id: SessionMessageTable.id,
          seq: SessionMessageTable.seq,
          text: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.text')`,
        })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "user"),
            sql`${SessionMessageTable.seq} > coalesce((select max(${sql.raw("before.seq")}) from ${SessionMessageTable} as before
              where ${sql.raw("before.session_id")} = ${sessionID} and (${sql.raw("before.type")} = 'assistant'
                or (${sql.raw("before.type")} = 'compaction' and json_extract(${sql.raw("before.data")}, '$.status') = 'completed'))), -1)`,
          ),
        )
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      if (!prompts.length) return []
      const ids = prompts.map((prompt) => prompt.id)
      const recorded = yield* db
        .select({ id: MemoryPromptTable.message_id })
        .from(MemoryPromptTable)
        .where(inArray(MemoryPromptTable.message_id, ids))
        .all()
        .pipe(Effect.orDie)
      const messaged = yield* db
        .select({ id: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.memoryPrompt.prompt')` })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "synthetic"),
            gt(SessionMessageTable.seq, prompts[0]!.seq),
            sql`json_extract(${SessionMessageTable.data}, '$.metadata.memoryPrompt.prompt') is not null`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const asked = new Set<unknown>([...recorded.map((row) => row.id), ...messaged.map((row) => row.id)])
      return prompts.flatMap((prompt) =>
        asked.has(prompt.id) ? [] : [{ id: prompt.id as SessionMessage.ID, text: String(prompt.text ?? "") }],
      )
    })

    /** The ids of the entries the chat has in view: its start block's and those of the prompts' messages, the newest. */
    const inView = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const compaction = yield* MemoryOffer.latestCompaction(db, sessionID)
      const rows = yield* db
        .select({
          block: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.memory')`,
          prompt: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.memoryPrompt.entries')`,
        })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "synthetic"),
            compaction === undefined ? undefined : gt(SessionMessageTable.seq, compaction),
            or(
              sql`json_extract(${SessionMessageTable.data}, '$.metadata.memory') is not null`,
              sql`json_extract(${SessionMessageTable.data}, '$.metadata.memoryPrompt') is not null`,
            ),
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const ids = rows.flatMap((row) => {
        if (row.prompt !== null) return strings(row.prompt)
        const block = parsed(row.block)
        return typeof block === "object" && block !== null && "entries" in block
          ? [...strings(block.entries), ...("shown" in block ? strings(block.shown) : [])]
          : []
      })
      return [...new Set(ids)].slice(0, EXCLUDE)
    })

    return Service.of({
      // A help, never a condition of the step: a defect here is logged and the step goes on.
      ask: (input) =>
        ask(input).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("memory's prompt entries failed", { defect: String(defect) }),
          ),
        ),
    })
  }),
)

/** SQLite's `json_extract` answers an object or an array as its JSON text. */
function parsed(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value
}

function strings(value: unknown) {
  const list = parsed(value)
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, PacerEndpoint.node, PacerModels.node, PacerProject.node, MemoryClient.node],
})
