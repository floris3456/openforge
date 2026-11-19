import { expect } from "bun:test"
import { Automation } from "@opencode/core/automation"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { ArtifactTools } from "@opencode/core/tool/plugin/artifact"
import { AutomationTools } from "@opencode/core/tool/plugin/automation"
import { McpResourceTools } from "@opencode/core/tool/plugin/mcp-resource"
import { OpenCodeTools } from "@opencode/core/tool/plugin/opencode"
import { Document, Info } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { Model } from "@opencode/schema/model"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

// Google's Antigravity backend answers a fake 429 to a system instruction that names `tools.opencode.`; the names the
// model sees say openforge (the owner's decision of 2026-11-05).
it.effect("the model sees openforge's own tools under openforge, never opencode", () =>
  Effect.gen(function* () {
    const config = yield* Config.Test
    yield* config.setEntries([
      new Document({
        type: "document",
        info: new Info({ experimental: new ConfigExperimental.Info({ artifacts: true, automations: true }) }),
      }),
    ])
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, "test")
    yield* OpenCodeTools.Plugin.effect(host)
    yield* McpResourceTools.Plugin.effect(host)
    yield* ArtifactTools.Plugin.effect(host)
    yield* AutomationTools.Plugin.effect(host).pipe(Effect.provide(Layer.mock(Automation.Service)({})))

    const location = yield* Location.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const registry = yield* Tool.Service
    const snapshot = yield* registry.snapshot()
    const catalog = CodeModeCatalog.summarize(snapshot.codeModeCatalog ?? { tools: [] }, { budget: Infinity })
    const hooks = yield* PluginHooks.Service
    const event = yield* hooks.trigger("session", "context", {
      sessionID: session.id,
      model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") }),
      system: [],
      messages: [],
      options: {},
      agent: toolIdentity.agent,
      tools: {},
    })
    const system = event.system.map((part) => part.text).join("\n")
    const rendered = CodeModeInstructions.render(catalog)

    expect(catalog.namespaces.map((namespace) => namespace.name)).toContain("openforge")
    expect(catalog.namespaces.map((namespace) => namespace.name)).not.toContain("opencode")
    expect(catalog.namespaces.flatMap((namespace) => namespace.entries.map((entry) => entry.path))).toEqual(
      expect.arrayContaining([
        "openforge.session_move",
        "openforge.models",
        "openforge.list_mcp_resources",
        "openforge.artifact_create",
        "openforge.automation_create",
      ]),
    )
    expect(rendered).toContain("- openforge (")
    expect(rendered).not.toMatch(/\bopencode\b/)
    expect(system).toContain("tools.openforge.session_move")
    expect(system).not.toContain("tools.opencode.")
    // Direct names, as a model without Code Mode gets them.
    const direct = (yield* registry.snapshot([{ action: "execute", resource: "*", effect: "deny" }])).definitions.map(
      (tool) => tool.name,
    )
    expect(direct).toContain("openforge_session_move")
    expect(direct.filter((name) => name.startsWith("opencode"))).toEqual([])
  }),
)
