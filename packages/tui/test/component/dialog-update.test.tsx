/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { DialogUpdate } from "../../src/component/dialog-update"
import { ConfigProvider } from "../../src/config"
import type { UpdateOutcome, UpdateState } from "../../src/context/update-notification"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

// The dialog wraps long lines; compare the words.
const words = (frame: string) => frame.replace(/\s+/g, " ")

test("upgrade progress replaces checking, says what the switch waits for and reports a rollback", async () => {
  await using temporary = await tmpdir()
  const [state, setState] = createSignal<UpdateState>()
  const pending = Promise.withResolvers<UpdateOutcome>()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path, home: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <DialogUpdate
                    start={() => pending.promise}
                    state={state}
                    restart={() => {}}
                    title={(sessionID) => (sessionID === "ses_a" ? "Fix the tests" : undefined)}
                  />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Checking for a new openforge release"))
    setState({ type: "installing", version: "0.1.1" })
    await app.waitForFrame((frame) => frame.includes("Installing openforge 0.1.1") && !frame.includes("Checking"))
    setState({ type: "switching", version: "0.1.1" })
    await app.waitForFrame((frame) => frame.includes("Switching to openforge 0.1.1…"))
    const waiting = [
      { sessionID: "ses_a", kind: "tool" as const, name: "webfetch" },
      { sessionID: "ses_b", kind: "step" as const, name: "reply" },
    ]
    setState({ type: "switching", version: "0.1.1", waiting })
    await app.waitForFrame((frame) =>
      words(frame).includes('Switching to openforge 0.1.1; waiting for webfetch in "Fix the tests", a reply in ses_b…'),
    )
    setState({ type: "waiting", version: "0.1.1", waiting: waiting.slice(0, 1) })
    await app.waitForFrame((frame) =>
      words(frame).includes(
        'openforge 0.1.1 is installed. The chats did not pause within 2 minutes; it switches once this has finished: webfetch in "Fix the tests"',
      ),
    )
    setState({ type: "waiting", version: "0.1.1" })
    await app.waitForFrame((frame) =>
      words(frame).includes("The running service cannot pause; it switches once no chat is running."),
    )
    const failure = "upgrade to 0.1.1 failed: boom; still on 0.1.0. Log: /data/log/upgrade.log"
    setState({ type: "failed", version: "0.1.1", message: failure })
    pending.reject(new Error(failure))
    await app.waitForFrame(
      (frame) => frame.includes("upgrade to 0.1.1 failed: boom; still on 0.1.0") && !frame.includes("Switching"),
    )
    expect(app.captureCharFrame()).not.toContain("Restart")
  } finally {
    pending.resolve({ type: "current", version: "0.0.0" })
    app.renderer.destroy()
  }
})

test("a finished switch says whether this screen restarts on its own", async () => {
  await using temporary = await tmpdir()
  const [state] = createSignal<UpdateState>({ type: "switched", version: "0.0.1" })
  // "manual": this screen cannot restart itself; "held": it waits for the typed prompt.
  const [restarts, setRestarts] = createSignal<"manual" | "held" | "now">("manual")
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path, home: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <DialogUpdate
                    state={state}
                    restart={() => {}}
                    held={restarts() === "manual" ? undefined : () => restarts() === "held"}
                  />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("openforge 0.0.1 is running. Restart closes this screen"))
    expect(app.captureCharFrame().toLowerCase()).toContain("restart")
    setRestarts("now")
    await app.waitForFrame((frame) => frame.includes("Switched to openforge 0.0.1; restarting"))
    setRestarts("held")
    await app.waitForFrame((frame) => frame.includes("Switched to openforge 0.0.1; this screen restarts on it once"))
  } finally {
    app.renderer.destroy()
  }
})
