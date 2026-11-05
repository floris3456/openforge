import { describe, expect, test } from "bun:test"
import { Shell } from "@opencode/schema/shell"
import { ShellResult } from "../src/shell/result"

const ended = (
  info: Partial<Shell.Info>,
  rest: Partial<Omit<ShellResult.Result, "info">> = {},
): ShellResult.Result => ({
  info: {
    id: Shell.ID.create(),
    status: "exited",
    command: "make test",
    cwd: "/project",
    shell: "/bin/sh",
    file: "/data/shell/project/out",
    metadata: {},
    time: { started: 1, completed: 2 },
    ...info,
  },
  capture: { output: "ok", truncated: false },
  ...rest,
})

// What the model is told about a command the user typed with `!`.
describe("a ! command's notice", () => {
  test("reports a command that exited with its output", () => {
    const notice = ShellResult.userNotification(ended({ exit: 0 }))
    expect(notice.metadata.state).toBe("completed")
    expect(notice.text).toContain('state="completed" command="make test">\nok\n</shell>')
  })

  test("reports a command that was stopped as cancelled", () => {
    const notice = ShellResult.userNotification(ended({ status: "killed" }))
    expect(notice.metadata.state).toBe("cancelled")
    expect(notice.text).toContain("ok\n\nCancelled\n</shell>")
  })

  test("reports a command whose tool runner died as failed, with why", () => {
    const notice = ShellResult.userNotification(
      ended(
        { status: "killed" },
        { capture: { output: "", truncated: false }, error: "the tool runner stopped unexpectedly" },
      ),
    )
    expect(notice.metadata.state).toBe("error")
    expect(notice.text).toContain(
      'state="error" command="make test">\nFailed: the tool runner stopped unexpectedly\n</shell>',
    )
    expect(notice.text).not.toContain("Cancelled")
  })
})
