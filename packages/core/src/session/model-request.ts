export * as SessionModelRequest from "./model-request.js"

import {
  ai,
  AssistantMessage,
  type ContentPart,
  GENERATION_KEYS,
  type GenerationOptionsFields,
  LanguageModel,
  type LLM,
  type LLMRequest,
  type Media,
  type MediaPart,
  Message,
  SystemPart,
  ToolDefinition,
  ToolMessage,
  type ToolResultPart,
  UserMessage,
} from "@opencode/ai/effect"
import { composeMiddleware, type StreamOptions } from "@opencode/ai/route"
import type {
  SessionCompaction,
  SessionContext,
  SessionGenerate,
  SessionRequest,
  SessionRequestKind,
  SessionRequestMessage,
  SessionTitle,
} from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Content } from "@opencode/schema/tool"
import { Cause, Context, Effect, Layer, Option, Result, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { App } from "../app.js"
import { Database } from "../database/database.js"
import { ImageBank } from "../image/bank.js"
import { ImageBudget } from "../image/budget.js"
import { ImageFit } from "../image/fit.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerEnv } from "../pacer/env.js"
import { PacerWhere } from "../pacer/where.js"
import { PacerOffer } from "../pacer/offer.js"
import type { PacerPins } from "../pacer/pins.js"
import { PacerProject } from "../pacer/project.js"
import { PacerTools } from "../pacer/tools.js"
import { Instructions } from "../instructions/index.js"
import { Permission } from "../permission.js"
import { PluginHooks } from "../plugin/hooks.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { Tool } from "../tool.js"
import { SessionAffinity } from "./affinity.js"
import { SessionModelTransport } from "./model-transport.js"
import { SessionPromptStart } from "./prompt-start.js"
import { SessionProxyRequest } from "./proxy-request.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionSystemPrompt } from "./system-prompt.js"
import { SessionThinkingBudget } from "./thinking-budget.js"
import { systemReminder, toLLMMessages } from "./runner/to-llm-message.js"
import type { SessionMessage } from "./message.js"

const IMAGE_BYTES_TRIGGER = 25 * 1024 * 1024 // 25 MiB
const IMAGE_BYTES_TARGET = 15 * 1024 * 1024 // 15 MiB
const IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"
// Used when the catalog has no output limit for the model.
const OUTPUT_TOKEN_FALLBACK = 32_000
// No reply needs more, however much the model allows.
const OUTPUT_TOKEN_MAX = 256_000
// Prompt text is estimated from its characters (`SessionCompaction.estimatePrompt`), which can run low on dense text.
const ESTIMATE_ERROR = 0.15
// Share of the window a turn leaves unused when its output limit is fitted to the room left. Providers count a few
// tokens more than we do (chat template, tool schemas), and strict ones reject input plus output past the window.
// Compaction sizes its summary against its own reserve instead.
export const WINDOW_HEADROOM = 0.01
// Never ask for less; only reachable with automatic compaction off, since it keeps the window from filling this far.
const OUTPUT_TOKEN_MIN = 1_024

/** Tool errors, plus the user declining a permission or dismissing a question. */
export type ExecuteError = Tool.Error | Permission.DeclinedError | QuestionTool.CancelledError

export interface Prepared<Event = SessionRequest> {
  readonly event: Event
  readonly request: LLMRequest
  readonly options: StreamOptions
  readonly retry: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  /** The proxy's ID of this request, once its answer arrived; undefined for other providers (`proxyRequestID`). */
  readonly proxyRequestID?: () => string | undefined
  /**
   * The provider refused this prompt itself (`PacerAnswers.refused`): the chat's recorded start goes, so that its next
   * step records the start as it is then (`SessionPromptStart`).
   */
  readonly refused?: Effect.Effect<void>
  /** Runs a tool call against the tools this request advertised. */
  readonly executeTool: (
    input: Parameters<Tool.Snapshot["execute"]>[0],
  ) => Effect.Effect<Tool.NormalizedResult, ExecuteError>
}

export interface Input {
  readonly session: SessionSchema.Info
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly tools?: Tool.Snapshot
  readonly system: Array<SystemPart>
  /**
   * The text of `system`'s first part when it is the agent's prompt (`baseTranscript`'s `start`), which a reminder of a
   * warm chat's changes calls so (`SessionPromptStart`).
   */
  readonly start?: string
  readonly messages: Array<SessionRequestMessage>
  readonly toolChoice?: LLM.LLMRequestInput["toolChoice"]
  /** Only the durable runner may use a stateful WebSocket. */
  readonly webSocket?: "session"
  /** Prompt size, measured by the provider or estimated. The default output limit leaves room for it. */
  readonly inputTokens?: { readonly measured: number; readonly estimated: number }
  /**
   * openforge: the chat's largest measured size since its latest compaction, by which a step keeps its manual thinking
   * budget (`SessionThinkingBudget.peak`).
   */
  readonly peak?: number
  /**
   * openforge: the prompt size at which the chat compacts automatically (`SessionCompaction.threshold`), which a manual
   * thinking budget that no longer fits is fitted to.
   */
  readonly threshold?: number
  /** Whether the chat compacts automatically, which a step tells a proxy that asks for compactions. */
  readonly autoCompaction?: boolean
  /** openforge: the model's entry when the chat gets optimized images (`ImageBank`). */
  readonly images?: ImageFit.Model
  /** openforge: the agent's Code Mode pins, for the chat's list read only (`SessionContext.Selection.pins`). */
  readonly pins?: PacerPins.Pins
}

/** The default output limit: the catalog limit, fitted to the room the prompt leaves in the context window. */
export const outputLimit = (limit: Model.Info["limit"], inputTokens?: Input["inputTokens"], headroom = 0) => {
  const requested = Math.min(limit.output > 0 ? limit.output : OUTPUT_TOKEN_FALLBACK, OUTPUT_TOKEN_MAX)
  if (inputTokens === undefined || limit.context <= 0) return requested
  const room =
    Math.floor(limit.context * (1 - headroom)) -
    inputTokens.measured -
    Math.ceil(inputTokens.estimated * (1 + ESTIMATE_ERROR))
  return Math.min(requested, Math.max(OUTPUT_TOKEN_MIN, room))
}

export const baseTranscript = (input: {
  readonly agent: Agent.Info
  readonly model: SessionRunnerModel.Resolved
  readonly tools: Tool.Snapshot
  readonly initial: ReadonlyArray<Instructions.Rendered>
  readonly messages: ReadonlyArray<SessionMessage.Info>
}) => {
  const providerMetadataKey = input.model.model.route.providerMetadataKey ?? input.model.model.provider
  const start = input.agent.system
    ? input.agent.system
    : SessionSystemPrompt.make(input.tools.definitions.map((tool) => tool.name))
  return {
    providerMetadataKey,
    /** The agent's prompt: `system`'s first part. */
    start,
    system: [
      SystemPart.make(start),
      {
        ...SystemPart.make(Instructions.join(input.initial)),
        metadata: { experimental: { instructions: input.initial } },
      },
    ].filter((part) => part.text.length > 0),
    // Hooks read each stored message's metadata on the messages built from it; `prepare` strips it before the request.
    messages: input.messages.flatMap((message) =>
      toLLMMessages([message], input.model.ref, providerMetadataKey).map(
        (item): SessionRequestMessage =>
          message.metadata === undefined || item.id !== message.id ? item : { ...item, metadata: message.metadata },
      ),
    ),
  }
}

const mimeToModality = (mime: string) => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
}

// xAI rejects any other image type (e.g. GIF) with invalid_image, and the stored image would fail every later turn.
const XAI_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"])

const unsupportedMedia = (
  mime: string,
  name: string | undefined,
  capabilities: Model.Capabilities,
  provider: string | undefined,
) => {
  const modality = mimeToModality(mime)
  if (!modality) return
  const unsupported = !capabilities.input.some((item) => item.startsWith(modality))
    ? modality
    : provider === "xai" && modality === "image" && !XAI_IMAGE_MIMES.has(mime.toLowerCase())
      ? mime
      : undefined
  if (!unsupported) return
  return `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${unsupported} input). Inform the user.`
}

// The inline budget counts base64 characters, which are ASCII, so a string's length is its size without scanning it.
// Remote and provider-referenced media carry no local payload and never count toward the inline budget.
const mediaBytes = (media: Media.Asset) => {
  if (media.source.type === "base64") return media.source.data.length
  if (media.source.type === "bytes") return Math.ceil(media.source.data.byteLength / 3) * 4
  return 0
}

/** Replaces media with the returned text; messages without replacements are returned unchanged. */
const replaceMedia = (
  messages: LLMRequest["messages"],
  replace: (media: { mime: string; name: string | undefined; bytes: () => number }) => string | undefined,
) => {
  const media = (part: MediaPart) => {
    const text = replace({ mime: part.media.mediaType, name: part.filename, bytes: () => mediaBytes(part.media) })
    return text === undefined ? part : Message.text(text)
  }
  const toolResult = (part: ToolResultPart) => {
    if (part.result.type !== "content") return part
    const result = part.result
    const value = result.value.map((item): Content => {
      if (item.type !== "file") return item
      const text = replace({ mime: item.mime, name: item.name, bytes: () => item.uri.length })
      return text === undefined ? item : { type: "text", text }
    })
    return value.every((item, index) => item === result.value[index]) ? part : { ...part, result: { ...result, value } }
  }
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return message
      case "user": {
        const content = message.content.map((part) => (part.type === "media" ? media(part) : part))
        return sameParts(content, message.content) ? message : new UserMessage({ ...message, content })
      }
      case "assistant": {
        const content = message.content.map((part) => {
          if (part.type === "media") return media(part)
          return part.type === "tool-result" ? toolResult(part) : part
        })
        return sameParts(content, message.content) ? message : new AssistantMessage({ ...message, content })
      }
      case "tool": {
        const content = message.content.map(toolResult)
        return sameParts(content, message.content) ? message : new ToolMessage({ ...message, content })
      }
    }
  })
}

const sameParts = (next: ReadonlyArray<ContentPart>, previous: ReadonlyArray<ContentPart>) =>
  next.every((part, index) => part === previous[index])

export const unsupportedParts = (
  messages: LLMRequest["messages"],
  capabilities: Model.Capabilities,
  provider?: string,
) => replaceMedia(messages, (media) => unsupportedMedia(media.mime, media.name, capabilities, provider))

export const boundImages = (messages: LLMRequest["messages"]) => {
  const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")
  const sizes = messages.flatMap((message) =>
    message.content.flatMap((part) => {
      if (part.type === "media") return isImage(part.media.mediaType) ? [mediaBytes(part.media)] : []
      if (part.type !== "tool-result" || part.result.type !== "content") return []
      return part.result.value.flatMap((item: Content) =>
        item.type === "file" && isImage(item.mime) ? [item.uri.length] : [],
      )
    }),
  )
  // Replay the images in order, dropping the oldest down to the target whenever the kept payload passes the trigger.
  // A new image then moves the cut only every (trigger - target) bytes instead of on every request, so the replaced
  // prefix, and with it the provider's prompt cache, stays the same between cuts.
  let cut = 0
  let kept = 0
  for (const size of sizes) {
    kept += size
    if (kept <= IMAGE_BYTES_TRIGGER) continue
    while (kept > IMAGE_BYTES_TARGET) kept -= sizes[cut++]!
  }
  if (cut === 0) return messages

  let index = 0
  return replaceMedia(messages, (media) => {
    if (!isImage(media.mime)) return
    return index++ < cut ? IMAGE_REMOVED : undefined
  })
}

type Definitions = PluginHooks.Domains["session"]["context"]["tools"]

/** The definition a tool reshaped like this on the step before was sent as, so an unchanged step sends the same object. */
const reshapedBefore = new WeakMap<ToolDefinition, ToolDefinition>()

/**
 * The definition sent for `tool` under `name`, as the hooks left its copy `hooked`: the registry's own object when
 * they changed nothing, the step before's when they changed it the same way, and a new one otherwise. Compared field
 * by field, nothing serialised, so a warm step with nothing changed tells it by identity (`SessionPromptStart`).
 */
function sent(tool: ToolDefinition, name: string, hooked: Definitions[string]) {
  if (
    name === tool.name &&
    hooked.description === tool.description &&
    SessionPromptStart.equal(hooked.input, tool.inputSchema)
  )
    return tool
  const before = reshapedBefore.get(tool)
  if (
    before !== undefined &&
    before.name === name &&
    before.description === hooked.description &&
    SessionPromptStart.equal(before.inputSchema, hooked.input)
  )
    return before
  const made = new ToolDefinition({ ...tool, name, description: hooked.description, inputSchema: hooked.input })
  reshapedBefore.set(tool, made)
  return made
}

/**
 * One run of the request's hooks over `draft` and `definitions`: what they shaped, and each definition they kept, as
 * sent under its key (`sent`) beside the tool it runs (`t`). Definitions are shared across steps and sessions, and
 * hooks may edit schemas in place, so each hook gets a deep copy; hooks rename a tool by moving its definition to a
 * new key, so after the hook the tool is found by the copy's identity first, then by key. Entries matching neither
 * were invented by a hook and are dropped.
 */
const hooked = Effect.fnUntraced(function* <S extends SessionRequest & { tools?: Definitions }>(
  shape: (draft: SessionRequest, tools: Definitions) => Effect.Effect<S>,
  draft: SessionRequest,
  definitions: ReadonlyArray<ToolDefinition>,
) {
  const given = new Map(
    definitions.map(
      (t) => [{ description: t.description, input: JSON.parse(JSON.stringify(t.inputSchema)) }, t] as const,
    ),
  )
  const shaped = yield* shape(draft, Object.fromEntries(Array.from(given, ([d, t]) => [t.name, d])))
  const byName = new Map(definitions.map((t) => [t.name, t]))
  const reshaped = Object.entries(shaped.tools ?? {}).flatMap(([name, d]) => {
    const t = given.get(d) ?? byName.get(name)
    return t ? [{ t, sent: sent(t, name, d) }] : []
  })
  return { shaped, reshaped, sent: reshaped.map((entry) => entry.sent) }
})

/** Builds the model request for each session flow. Each entry runs its own plugin hook. */
export interface Interface {
  readonly primary: (input: Input) => Effect.Effect<Prepared<SessionContext>>
  readonly compaction: (input: Input) => Effect.Effect<Prepared<SessionCompaction>>
  readonly generate: (input: Input) => Effect.Effect<Prepared<SessionGenerate>>
  readonly title: (input: Input) => Effect.Effect<Prepared<SessionTitle>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelRequest") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const transport = yield* SessionModelTransport.Service
    const app = yield* App.Service
    const pacerTools = yield* PacerTools.Service
    const pacerProject = yield* PacerProject.Service
    const database = yield* Effect.serviceOption(Database.Service)
    const starts = yield* Effect.serviceOption(SessionPromptStart.Service)
    const where = yield* Effect.serviceOption(PacerWhere.Service)
    const env = yield* Effect.serviceOption(PacerEnv.Service)
    // openforge: the tool's images arrive whole in its result and are fitted once, here (ImageBank).
    const bankImages = (
      execution: Effect.Effect<Tool.NormalizedResult, Tool.Error>,
      sessionID: SessionSchema.ID,
      model: ImageFit.Model,
      tool: string,
    ) =>
      Option.isNone(database)
        ? execution
        : execution.pipe(
            Effect.flatMap((result) =>
              ImageBank.arriveContent(database.value.db, sessionID, model, tool, result.content).pipe(
                Effect.map((content) => ({ ...result, content })),
              ),
            ),
            Effect.provideService(ImageBank.Current, { db: database.value.db, sessionID, model }),
          )
    const prepare = Effect.fn("SessionModelRequest.prepare")(function* <
      S extends SessionRequest & { tools?: Definitions },
    >(kind: SessionRequestKind, input: Input, shape: (draft: SessionRequest, tools: Definitions) => Effect.Effect<S>) {
      const session = input.session
      const model = input.model
      const scope = { sessionID: session.id, agent: input.agent, model: model.ref, kind }
      const projected = yield* pacerProject.session(session)
      const project = projected.headers
      const place =
        String(model.ref.providerID) === PacerEndpoint.id && Option.isSome(where)
          ? yield* where.value.folder(session.location.directory)
          : undefined
      // openforge: the .env values CPP hides as exact ones are its project's repository's, else its own folder's.
      const envPlace =
        projected.project !== undefined
          ? { root: projected.repository, deep: true }
          : { root: session.location.directory, deep: false }
      const envHttp =
        String(model.ref.providerID) === PacerEndpoint.id && Option.isSome(env) ? env.value.http(envPlace) : undefined
      const tools = input.tools ?? {
        definitions: [],
        execute: () => new Tool.Error({ message: "Tools are not available for this request" }),
      }
      // What decides the tools now: CPP's tools, its memory tools among them, as the chat's list defines them, before
      // any hook, so plugins' hooks see and may change them.
      const now = Effect.gen(function* () {
        const known = yield* pacerTools.known()
        // With none known at the endpoint (a server whose capabilities lack `pacer.tools`, nothing kept yet), the
        // list is read anyway, so that what it names is registered for the chat's later steps.
        if (known.size > 0 && !PacerOffer.wanted(tools.definitions, known)) return tools.definitions
        return PacerOffer.apply(
          tools.definitions,
          yield* pacerTools.list(
            PacerTools.listInput({
              session,
              project,
              model: model.ref.id,
              agent: input.agent,
              pins: input.pins,
              codemode: PacerOffer.executes(tools.definitions),
              step: kind === "primary",
              continues: input.messages.some((message) => message.role === "assistant"),
            }),
          ),
          known,
        )
      })
      const definitions = yield* now
      const chat = {
        sessionID: session.id,
        agent: input.agent,
        model: model.ref,
        ...(model.cache?.ttl === undefined ? {} : { ttl: model.cache.ttl }),
      }
      // A chat recorded before the system parts were builds this step's start as 0.0.50 did, from its record: the
      // bytes 0.0.50 sent, so the upgrade costs no cache (`SessionPromptStart.legacy`).
      const legacy = Option.isSome(starts) ? yield* starts.value.legacy({ ...chat, kind }) : undefined
      // Hooks change the parts list in place; the start as it is now takes it as it came.
      const parts = legacy === undefined ? input.system : [...input.system]
      // Hooks see the default output limit and may change or remove it. Titles and generate keep the provider default,
      // because their reasoning is hard to budget.
      const fitted = outputLimit(model.limit, input.inputTokens, WINDOW_HEADROOM)
      const options =
        kind === "primary"
          ? { maxTokens: fitted }
          : kind === "compaction"
            ? { maxTokens: outputLimit(model.limit, input.inputTokens) }
            : {}
      const sending = yield* hooked(
        shape,
        {
          sessionID: session.id,
          model: model.ref,
          system:
            legacy !== undefined &&
            input.start !== undefined &&
            legacy.system !== undefined &&
            legacy.system !== input.start
              ? [SystemPart.make(legacy.system), ...parts.slice(1)]
              : input.system,
          messages: input.messages,
          options,
        },
        legacy?.definitions ?? definitions,
      )
      const shaped = sending.shaped
      // The start as it is now, which the reminder compares: its hooks see the messages as the step sends them, so
      // what a hook adds to them it finds there and adds no second time.
      const current =
        legacy === undefined
          ? undefined
          : yield* hooked(
              shape,
              {
                sessionID: session.id,
                model: model.ref,
                system: parts,
                messages: [...shaped.messages],
                options: { ...options },
              },
              definitions,
            )
      // A warm chat sends its start as recorded at its latest cold point, every system part and tool definition as
      // they were sent then, whatever changed since (`SessionPromptStart`).
      const start = Option.isSome(starts)
        ? yield* starts.value.resolve({
            kind,
            ...chat,
            system: shaped.system,
            definitions: sending.sent,
            prompt: input.start !== undefined,
            moved: PacerOffer.codemode(yield* pacerTools.known()),
            ...(current ? { now: { system: current.shaped.system, definitions: current.sent } } : {}),
          })
        : { system: shaped.system, definitions: sending.sent }
      const reshaped = current?.reshaped ?? sending.reshaped
      // Calls run the current tools; a recorded one no longer offered is kept, so its call answers that it is
      // unavailable, or runs from Code Mode when it moved there.
      const runs = new Map(reshaped.map((entry) => [entry.sent.name, entry.t] as const))
      if (start.definitions !== (current ?? sending).sent)
        for (const t of start.definitions) if (!runs.has(t.name)) runs.set(t.name, t)
      // A reminder stored for this step goes after the history, where the next step's history holds it; before the
      // closing assistant message a step at its limit adds, which is not stored.
      const reminder = "reminder" in start ? start.reminder : undefined
      const end = shaped.messages.at(-1)?.role === "assistant" ? shaped.messages.length - 1 : shaped.messages.length
      const messages = reminder
        ? [
            ...shaped.messages.slice(0, end),
            // As the next step's history sends it: a synthetic message, marked (spec checkpoint, section 1).
            Message.make({ id: reminder.id, role: "user", content: systemReminder(reminder.text) }),
            ...shaped.messages.slice(end),
          ]
        : shaped.messages
      const entries = Object.entries(shaped.options)
      const generation = Object.fromEntries(entries.filter(([k]) => GENERATION_KEYS.has(k))) as GenerationOptionsFields
      const providerOptions = Object.fromEntries(entries.filter(([k]) => !GENERATION_KEYS.has(k)))
      const affinity = SessionAffinity.get(session)
      // Strip the stored metadata hooks could read, so it never reaches the provider.
      const supported = unsupportedParts(
        messages.map((message) => {
          if (!("metadata" in message) || message.metadata === undefined) return message
          const { metadata, ...rest } = message
          return Message.make(rest)
        }),
        model.capabilities,
        model.model.provider,
      )
      // openforge: optimized images are never cut (ImageBudget).
      const images = input.images
      const built = ai.request({
        model: model.model,
        headers: {
          "x-opencode-session-id": session.id,
          ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
          "x-session-affinity": affinity,
          "X-Session-Id": affinity,
          ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          "User-Agent": App.useragent(app),
          "x-opencode-project": session.projectID,
          "x-opencode-session": affinity,
          "x-opencode-client": app.name,
          ...PacerHeaders.make({
            providerID: model.ref.providerID,
            kind,
            sessionID: session.id,
            parentID: session.parentID,
            auto: input.autoCompaction === true,
            project,
            where: place,
            agent: input.agent,
          }),
        },
        // TODO: Persist cache lineage so nested forks reuse the root session's cache key.
        promptCacheKey: /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity,
        cache: model.cache?.ttl === undefined ? undefined : { ttl: model.cache.ttl },
        system: [...start.system],
        messages: images ? ImageBudget.bound(supported, ImageFit.requestLimits(images)) : boundImages(supported),
        tools: start.definitions.map((t) => ({
          ...t,
          freeform: t.freeform && model.capabilities.freeform?.includes(t.freeform.type) ? t.freeform : undefined,
        })),
        toolChoice: input.toolChoice,
        ...generation,
        providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
      })
      // openforge: a step keeps the chat's manual thinking budget while it fits, unless a hook set its output limit.
      const base =
        kind === "primary" && generation.maxTokens === fitted
          ? SessionThinkingBudget.keep(built, {
              limit: model.limit,
              peak: input.peak,
              threshold: input.threshold,
              output: outputLimit(model.limit),
              headroom: WINDOW_HEADROOM,
            })
          : built

      const baseURL = base.model.route.endpoint.baseURL
      const modelHook = yield* hooks.trigger("session", "model.request", {
        ...scope,
        baseURL,
        headers: { ...base.headers },
      })
      const route =
        modelHook.baseURL !== undefined && modelHook.baseURL !== baseURL
          ? base.model.route.with({ endpoint: { baseURL: modelHook.baseURL } })
          : base.model.route
      const request = {
        ...base,
        model: route === base.model.route ? base.model : LanguageModel.update(base.model, { route }),
        headers: Object.keys(modelHook.headers).length === 0 ? undefined : modelHook.headers,
      }
      const hasHttpHooks =
        (yield* hooks.has("session", "http.request", model.ref.providerID)) ||
        (yield* hooks.has("session", "http.response", model.ref.providerID))
      const httpHooks: StreamOptions["http"] = hasHttpHooks
        ? (req, handler) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(req)
              const before = yield* hooks.trigger("session", "http.request", { ...scope, request })
              // A hook that kept the request object cannot have replaced its body, so the original body is sent as is.
              // Reading it back would hold a second full copy of the request, screenshots included, for the whole call.
              const sent =
                before.request === request
                  ? HttpClientRequest.setBody(HttpClientRequest.fromWeb(request), req.body)
                  : before.request.body
                    ? HttpClientRequest.bodyUint8Array(
                        HttpClientRequest.fromWeb(before.request),
                        new Uint8Array(yield* Effect.promise(() => before.request.clone().arrayBuffer())),
                        before.request.headers.get("content-type") ?? undefined,
                      )
                    : HttpClientRequest.fromWeb(before.request)
              const res = yield* handler(sent)
              const after = yield* hooks.trigger("session", "http.response", {
                ...scope,
                request: before.request,
                response: new Response(
                  [204, 205, 304].includes(res.status) ? null : yield* Stream.toReadableStreamEffect(res.stream),
                  { status: res.status, headers: res.headers },
                ),
              })
              return HttpClientResponse.fromWeb(sent, after.response)
            })
        : undefined
      // HTTP hooks wrap every HTTP request, including the WebSocket fallback path. The route decides
      // which transport actually carries the request, so both hook families are always offered.
      const webSocket =
        input.webSocket === "session" && model.transport === "websocket"
          ? transport.bind(
              session.id,
              {
                handshake: (connect) =>
                  hooks
                    .trigger("session", "experimental.ws.handshake", {
                      ...scope,
                      url: connect.url,
                      headers: connect.headers,
                    })
                    .pipe(Effect.map((event) => ({ url: event.url, headers: event.headers }))),
                send: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.send", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
                receive: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.receive", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
              },
              model.chunkTimeout,
            )
          : undefined
      // The proxy's request ID is read on native HTTP routes only, which CLIProxyPacer's models use: any HTTP
      // middleware on the AI SDK route copies the request body, and a WebSocket step gets no HTTP answer.
      const proxy =
        request.model.route.protocol === "ai-sdk" || webSocket
          ? undefined
          : SessionProxyRequest.capture(httpHooks, (version) => pacerTools.seen(session.id, version))
      // The set goes nearest the wire: the hooks and the request ID see one request and its last answer.
      const http = composeMiddleware(proxy?.http ?? httpHooks, envHttp)

      return {
        event: shaped,
        request,
        options: { ...(http ? { http } : {}), ...(webSocket ? { webSocket } : {}) },
        ...(proxy ? { proxyRequestID: proxy.current } : {}),
        ...(kind === "primary" && Option.isSome(starts) ? { refused: starts.value.refused(session.id) } : {}),
        retry: (event: Parameters<Prepared["retry"]>[0]) =>
          hooks.trigger("session", "retry", event).pipe(Effect.asVoid),
        // Permission.assert and the question tool throw declines as defects so tools cannot
        // catch them and turn a "no" into model-visible output. Recover them here as failures,
        // including declines a tool rethrew and its wrapper attached to a Tool.Error, as Promise
        // plugin tools do.
        executeTool: (call: Parameters<Prepared["executeTool"]>[0]) =>
          tools.execute({ ...call, definitions: runs }).pipe(
            (execution) => (input.images ? bankImages(execution, session.id, input.images, call.call.name) : execution),
            (execution) =>
              envHttp && Option.isSome(env)
                ? Effect.ensuring(execution, env.value.named(envPlace, call.call.input, session.location.directory))
                : execution,
            Effect.catchCauseFilter(
              (cause) => {
                const decline = cause.reasons
                  .map((r) => (Cause.isDieReason(r) ? r.defect : Cause.isFailReason(r) ? r.error.error : undefined))
                  .find(
                    (value): value is Permission.DeclinedError | QuestionTool.CancelledError =>
                      value instanceof Permission.DeclinedError || value instanceof QuestionTool.CancelledError,
                  )
                return decline ? Result.succeed(decline) : Result.fail(cause)
              },
              (decline) => Effect.fail(decline),
            ),
          ),
      }
    })

    const agentHook =
      (name: "context" | "compaction" | "generate", agent: Agent.ID) => (draft: SessionRequest, tools: Definitions) =>
        hooks.trigger("session", name, { ...draft, agent, tools })

    return Service.of({
      primary: (input) => prepare("primary", input, agentHook("context", input.agent)),
      compaction: (input) => prepare("compaction", input, agentHook("compaction", input.agent)),
      generate: (input) => prepare("generate", input, agentHook("generate", input.agent)),
      title: (input) => prepare("title", input, (draft) => hooks.trigger("session", "title", draft)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    PluginHooks.node,
    SessionModelTransport.node,
    App.node,
    PacerTools.node,
    PacerProject.node,
    Database.node,
    SessionPromptStart.node,
    PacerWhere.node,
    PacerEnv.node,
  ],
})
