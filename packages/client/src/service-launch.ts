import { spawn, type ChildProcess } from "node:child_process"
import { constants } from "node:os"

/**
 * A background service started by a client. `pid`, `exitCode` and `signalCode` describe the service itself, `kill`
 * signals it and `exited` settles once it has ended. `launcher` carries the service's stderr, reports a failed start
 * with `error`, and emits `close` once the service and everything sharing its stderr have ended.
 */
export type ServiceProcess = {
  readonly launcher: ChildProcess
  readonly pid: number | undefined
  readonly exitCode: number | null
  readonly signalCode: string | null
  readonly exited: Promise<void>
  readonly kill: (signal?: NodeJS.Signals) => boolean
}

// The service must not be a child of the client that starts it. A TUI that replaces itself with a new release
// (execve) no longer knows its children and never reaps them, so a service it stopped would stay a zombie that still
// counts as running. On Unix `sh` starts the service from a subshell that prints its PID, waits for it and prints its
// exit status; `sh` itself exits at once, so the subshell and the service belong to init (or the nearest subreaper),
// which reaps them. The command comes in the environment, so that only the service's own command line names it.
const script = String.raw`
set --
i=0
while [ "$i" -lt "$SERVICE_LAUNCH_ARGC" ]; do
  eval "set -- \"\$@\" \"\$SERVICE_LAUNCH_ARG_$i\""
  unset "SERVICE_LAUNCH_ARG_$i"
  i=$((i + 1))
done
unset SERVICE_LAUNCH_ARGC
( "$@" </dev/null >/dev/null & echo "$!"; wait "$!"; echo "$?" ) &
`

export function launchService(
  command: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): ServiceProcess {
  if (process.platform === "win32") {
    const child = spawn(command, args, { detached: true, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env })
    return {
      launcher: child,
      get pid() {
        return child.pid
      },
      get exitCode() {
        return child.exitCode
      },
      get signalCode() {
        return child.signalCode
      },
      exited: new Promise((resolve) => child.once("exit", () => resolve()).once("error", () => resolve())),
      kill: (signal) => child.kill(signal),
    }
  }
  const argv = [command, ...args]
  const launcher = spawn("/bin/sh", ["-c", script], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      SERVICE_LAUNCH_ARGC: String(argv.length),
      ...Object.fromEntries(argv.map((value, index) => [`SERVICE_LAUNCH_ARG_${index}`, value])),
    },
  })
  let output = ""
  launcher.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk
  })
  if (launcher.stdout !== null && "unref" in launcher.stdout && typeof launcher.stdout.unref === "function")
    launcher.stdout.unref()
  // Line 0 is the service's PID, line 1 its exit status; each counts once it ends.
  const line = (index: number) => {
    const lines = output.split("\n")
    return lines.length > index + 1 ? Number(lines[index]) : undefined
  }
  // `wait` reports a service ended by signal N as 128 + N.
  const signal = () => {
    const status = line(1)
    if (status === undefined || status <= 128) return undefined
    return Object.entries(constants.signals).find((entry) => entry[1] === status - 128)?.[0]
  }
  return {
    launcher,
    get pid() {
      return line(0)
    },
    get exitCode() {
      if (signal() !== undefined) return null
      return line(1) ?? null
    },
    get signalCode() {
      return signal() ?? null
    },
    // Only `sh` and the subshell hold stdout (the service's goes to /dev/null), so it closes once the status is in.
    exited: new Promise((resolve) => {
      launcher.once("error", () => resolve())
      launcher.stdout?.once("close", () => resolve())
    }),
    kill: (name = "SIGTERM") => {
      const pid = line(0)
      // Once its status is in, the PID may belong to another process.
      if (pid === undefined || line(1) !== undefined) return false
      try {
        return process.kill(pid, name)
      } catch {
        return false
      }
    },
  }
}
