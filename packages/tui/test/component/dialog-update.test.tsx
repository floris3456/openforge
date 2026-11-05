/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { UpgradeOutcome, UpgradeState } from "@opencode/client/promise"
import { createSignal } from "solid-js"
import { DialogUpdate } from "../../src/component/dialog-update"
import { ConfigProvider } from "../../src/config"
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
  const [state, setState] = createSignal<UpgradeState>()
  const pending = Promise.withResolvers<UpgradeOutcome>()
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
      // A chat mid-reply: its model call and its step are one reply, and the model's name is not shown.
      { sessionID: "ses_b", kind: "model" as const, name: "slow" },
      { sessionID: "ses_b", kind: "step" as const, name: "reply" },
    ]
    setState({ type: "switching", version: "0.1.1", waiting })
    await app.waitForFrame((frame) =>
      words(frame).includes(
        'Switching to openforge 0.1.1; waiting for webfetch in "Fix the tests", a reply in an untitled chat…',
      ),
    )
    expect(words(app.captureCharFrame())).not.toContain("slow")
    setState({ type: "waiting", version: "0.1.1", expired: { limit: 90_000, waiting: waiting.slice(0, 1) } })
    await app.waitForFrame((frame) =>
      words(frame).includes(
        'openforge 0.1.1 is installed. The chats did not pause within 90 seconds; it switches once this has finished: webfetch in "Fix the tests".',
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
  const [state] = createSignal<UpgradeState>({ type: "switched", version: "0.0.1" })
  const [restarts, setRestarts] = createSignal(false)
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path, home: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <DialogUpdate state={state} restart={() => {}} restarts={restarts()} />
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
    await app.waitForFrame((frame) =>
      words(frame).includes("openforge 0.0.1 is running; exit and run openforge to use it."),
    )
    expect(app.captureCharFrame()).toContain("Exit")
    expect(app.captureCharFrame()).not.toContain("Restart")
    setRestarts(true)
    await app.waitForFrame(
      (frame) => frame.includes("Switched to openforge 0.0.1; restarting") && frame.includes("Restart"),
    )
  } finally {
    app.renderer.destroy()
  }
})
