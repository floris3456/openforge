export * as Desktop from "./desktop"

import { Product } from "@opencode/schema/product"

// `openforge notify --desktop`: a desktop notification through the system's own command, notify-send on Linux and
// osascript on macOS.

/** The command as argv, never a shell string. */
export function command(platform: NodeJS.Platform, title: string, message: string) {
  // The title and message reach the script as its arguments, so no text is ever AppleScript code.
  if (platform === "darwin")
    return [
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      message,
    ]
  // Notification servers may read the body as markup (KDE and GNOME do); the title is plain text.
  const body = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return ["notify-send", `--app-name=${Product.name}`, "--", title, body]
}

/** Shows desktop notifications on this machine, or says why it can't. */
export function notifier(platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") return { error: "desktop notifications are not supported on Windows" }
  if (platform !== "darwin" && Bun.which("notify-send") === null) return { error: "notify-send is not on PATH" }
  return {
    show: async (title: string, message: string) => {
      const argv = command(platform, title, message)
      const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      if (code === 0) return
      const detail = stderr.trim().split("\n").at(-1) ?? ""
      throw new Error(`${argv[0]} exited with ${code}${detail === "" ? "" : `: ${detail}`}`)
    },
  }
}
