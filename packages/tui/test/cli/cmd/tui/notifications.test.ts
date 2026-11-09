import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import type { Context, ToastOptions } from "@opencode/plugin/tui/context"
import Notifications from "../../../../src/feature-plugins/system/notifications"
import type { AttentionRequest } from "../../../../src/attention"
import { resolve } from "../../../../src/config"

// openforge: the notifications plugin keeps upstream's ID and runs openforge's events (attention-events.ts, whose rules
// test/attention-events.test.ts covers) against the TUI's attention host, asking the service for the chat's shells.

function setup(attention: object) {
  const handlers = new Map<string, ((event: OpenCodeEvent) => void)[]>()
  const toasts: ToastOptions[] = []
  const shells: unknown[] = []
  const context = {
    ui: { toast: { show: (toast: ToastOptions) => toasts.push(toast) } },
    attention,
    client: {
      shell: {
        list: async (input: unknown) => {
          shells.push(input)
          return { location: { directory: "/project" }, data: [] }
        },
      },
    },
    data: {
      on: (type: string, handler: (event: OpenCodeEvent) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), handler])
        return () => handlers.set(type, [])
      },
      session: {
        get: () => ({ id: "ses_chat", title: "The chat", location: { directory: "/project" } }),
        sync: async () => {},
        family: () => ["ses_chat"],
        status: () => "idle",
      },
    },
  } as unknown as Context
  const emit = (type: string, data: object) =>
    (handlers.get(type) ?? []).forEach((handler) => handler({ id: "evt", created: 0, type, data } as never))
  return { context, toasts, shells, handlers, emit }
}

test("keeps upstream's plugin ID, so -opencode.notifications still turns the events off", () => {
  expect(Notifications.id).toBe("opencode.notifications")
})

test("raises the events through the TUI's attention host, with the chat's shells asked of the service", async () => {
  const raised: AttentionRequest[] = []
  const host = {
    notify: async () => ({ ok: true, notification: true, sound: true }),
    raise: async (request: AttentionRequest) => {
      raised.push(request)
      return { ok: true, notification: true, sound: true }
    },
    settings: () => resolve({}, { terminalSuspend: true, environment: {} }).attention,
    ours: async () => true,
  }
  const plugin = setup(host)
  const dispose = await Notifications.setup(plugin.context)
  plugin.emit("session.execution.succeeded", { sessionID: "ses_chat" })
  await Bun.sleep(1)
  plugin.emit("session.execution.started", { sessionID: "ses_chat" })
  plugin.emit("session.execution.failed", { sessionID: "ses_chat", error: { type: "unknown", message: "boom" } })
  await Bun.sleep(1)
  expect(plugin.shells).toEqual([{ location: { directory: "/project" } }])
  expect(raised.map((request) => request.kind)).toEqual(["done", "error"])
  expect(plugin.toasts).toEqual([{ sessionID: "ses_chat", title: "Session failed", message: "boom", variant: "error" }])
  if (typeof dispose === "function") dispose()
})

test("a plain attention, without the TUI's settings, gets no events", async () => {
  const plugin = setup({ notify: async () => ({ ok: true, notification: true, sound: true }) })
  expect(await Notifications.setup(plugin.context)).toBeUndefined()
  expect(plugin.handlers.size).toBe(0)
})
