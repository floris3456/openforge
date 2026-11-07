import { PacerNotices } from "@opencode/core/pacer/notices"
import { Effect } from "effect"

/** `pacer.notices.*` in the `server.experimental` group: the cache notices the service holds for every TUI. */
export const makePacerNotices = Effect.gen(function* () {
  const notices = yield* PacerNotices.Service

  return {
    list: Effect.map(notices.list(), (data) => ({ data })),
    dismiss: (requestID: string) => notices.dismiss(requestID).pipe(Effect.as({ data: true as const })),
  }
})
