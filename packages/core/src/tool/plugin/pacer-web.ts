export * as PacerWebTools from "./pacer-web.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { isRecord } from "@opencode/util/record"
import { Effect, Stream } from "effect"
import { PacerEndpoint } from "../../pacer/endpoint.js"
import { PacerProject } from "../../pacer/project.js"
import { PacerTools } from "../../pacer/tools.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"

// CPP's four web tools as built-in tools, registered while a CPP address and key are set (not only once its catalog
// says so: a step resumed right after a restart sends the tools it had). Their definitions here never reach a model:
// each request puts the chat's own from CPP in their place, or leaves them out (`PacerOffer`). They ask as
// upstream's tools of their kind do, so the same permission rules govern them, and run as direct tools.

/** The tools, the permission action each asks as, and the argument it asks with. */
export const tools = [
  { name: "web_search", permission: "websearch", subject: "query" },
  { name: "web_research", permission: "websearch", subject: "question" },
  { name: "web_extract", permission: "webfetch", subject: "urls" },
  { name: "web_crawl", permission: "webfetch", subject: "url" },
] as const

/** The names CPP's answers give its services by (`data.provider`, the ids of its routing document), as shown. */
const services: Readonly<Record<string, string>> = {
  chatgpt: "ChatGPT",
  exa: "Exa",
  parallel: "Parallel",
  youcom: "You.com",
  tavily: "Tavily",
  valyu: "Valyu",
  firecrawl: "Firecrawl",
  serper: "Serper",
  serpapi: "SerpApi",
  hasdata: "HasData",
  linkup: "Linkup",
  cloro: "Cloro",
}

/** CPP's definitions, from the chat's list, replace these on every request. */
const placeholder = "One of CLIProxyPacer's web tools; each request carries CLIProxyPacer's own definition instead."

export const Plugin = {
  id: "opencode.tool.pacer-web",
  effect: Effect.fn("PacerWebTools.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    const endpoints = yield* PacerEndpoint.Service
    const calls = yield* PacerTools.Service
    const sessions = yield* Session.Service
    const projects = yield* PacerProject.Service

    const state = { enabled: (yield* endpoints.get()) !== undefined }
    yield* endpoints.changes().pipe(
      Stream.runForEach((endpoint) => {
        if ((endpoint !== undefined) === state.enabled) return Effect.void
        state.enabled = endpoint !== undefined
        return ctx.tool.reload()
      }),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.tool
      .transform((editor) => {
        if (!state.enabled) return
        for (const tool of tools)
          editor.add({
            name: tool.name,
            options: { codemode: false, permission: tool.permission },
            description: placeholder,
            input: { type: "object" },
            execute: (input, context) =>
              Effect.gen(function* () {
                const args = isRecord(input) ? input : {}
                // A job's next call names only its job.
                const job = typeof args.job_id === "string" ? args.job_id : undefined
                yield* permission
                  .assert({
                    action: tool.permission,
                    resources: job === undefined ? subject(args[tool.subject]) : [job],
                    save: ["*"],
                    metadata: args,
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, id: context.id },
                  })
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
                // A subagent's calls are rows of its own chat, nested under its parent's, as its model requests are.
                const session = yield* sessions.get(context.sessionID).pipe(Effect.orElseSucceed(() => undefined))
                const project = session ? (yield* projects.chat(session.projectID)).headers : undefined
                const answer = yield* calls
                  .call({
                    sessionID: context.sessionID,
                    parentID: session?.parentID,
                    project,
                    name: tool.name,
                    args: input,
                  })
                  // Not as the failure's cause, which would make it an unknown error rather than the tool's.
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
                // A failed call is still CPP's answer, whose text tells the model to go on without it.
                if (answer.error)
                  return yield* new ToolFailure({
                    message: answer.text || answer.error.message,
                    metadata: metadata(answer),
                  })
                return { content: answer.text, metadata: metadata(answer) }
              }),
          })
      })
      .pipe(Effect.orDie)
  }),
}

/** The subject's values: the query or question, the URLs, the URL. */
function subject(value: unknown) {
  if (typeof value === "string") return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** What the chat shows of a call: the service that served it, its job while one runs, and CPP's error code. */
function metadata(answer: PacerTools.Answer) {
  const data = isRecord(answer.data) ? answer.data : {}
  const provider = typeof data.provider === "string" && data.provider !== "" ? data.provider : undefined
  return {
    ...(provider ? { provider: services[provider] ?? provider } : {}),
    ...(typeof data.job_id === "string"
      ? { job: { id: data.job_id, ...(typeof data.status === "string" ? { status: data.status } : {}) } }
      : {}),
    ...(answer.error ? { error: answer.error.code } : {}),
  }
}
