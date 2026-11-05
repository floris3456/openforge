import { isShellNotFoundError, type OpenCodeClient, type ShellInfo } from "@opencode/client"

// Fast output arrives as many small events; a view takes it at most this often.
const BATCH_MS = 50
const RETRY_MS = 1_000

/** Runs `again` after a moment; the function it returns cancels that. */
export type ShellOutputRetry = (again: () => void) => () => void

const retryLater: ShellOutputRetry = (again) => {
  const timer = setTimeout(again, RETRY_MS)
  return () => clearTimeout(timer)
}

export type ShellOutputView = {
  /** Start over: discard what is shown. `omitted` says whether earlier output is left out. */
  reset: (omitted: boolean) => void
  output: (text: string) => void
  connected?: () => void
  exited?: (info: ShellInfo) => void
  /** Reading failed: retried after a moment, unless the command is gone (`missing`). */
  failed?: (missing: boolean) => void
}

/**
 * Follows a shell command's combined output as the server pushes it, from at most `limit` bytes
 * back, until the command has ended. A dropped connection, as across a server restart, picks up
 * where it left off, after `input.retry` (a second by default). Returns a function that stops following.
 */
export function followShellOutput(
  api: () => OpenCodeClient,
  input: { id: string; location?: { directory: string }; limit: number; retry?: ShellOutputRetry },
  view: ShellOutputView,
) {
  const aborted = new AbortController()
  const target = { id: input.id, location: input.location }
  let cursor: number | undefined
  let pending = ""
  let flush: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined

  const deliver = () => {
    clearTimeout(flush)
    flush = undefined
    if (!pending) return
    const text = pending
    pending = ""
    view.output(text)
  }
  const reset = (omitted: boolean) => {
    clearTimeout(flush)
    flush = undefined
    pending = ""
    view.reset(omitted)
  }

  const read = async () => {
    const client = api()
    const head = await client.shell.output({ ...target, cursor: Number.MAX_SAFE_INTEGER })
    view.connected?.()
    const start = Math.max(cursor ?? 0, head.data.size - input.limit)
    if (cursor === undefined || start > cursor) reset(start > 0)
    cursor = start
    const events = client.experimental.shell.watch({ ...target, cursor }, { signal: aborted.signal })
    for await (const event of events) {
      if (event.type === "exited") {
        deliver()
        return view.exited?.(event.info)
      }
      if (event.truncated) reset(true)
      cursor = event.cursor
      pending += event.output
      flush ??= setTimeout(deliver, BATCH_MS)
    }
    throw new Error("shell output stream ended before the command did")
  }

  const run = () => {
    void read().catch((cause: unknown) => {
      if (aborted.signal.aborted) return
      deliver()
      const missing = isShellNotFoundError(cause)
      view.failed?.(missing)
      if (!missing) cancel = (input.retry ?? retryLater)(run)
    })
  }
  run()
  return () => {
    aborted.abort()
    clearTimeout(flush)
    cancel?.()
  }
}
