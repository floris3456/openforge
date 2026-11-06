import type { OpenCodeClient } from "@opencode/client"
import type { Attention } from "@opencode/schema/attention"
import type { LogTags } from "./context/log"

// openforge: a TUI tells its service of every notification it shows, so the players that follow the service
// (`openforge notify`) play and show it on the machine you sit at. The answer says which of them are connected: the
// TUI then leaves its sound, or also its own notification, to them.

/** Tells the service of one occurrence; answers which players it leaves the sound and the notification to. */
export type Report = (occurrence: Attention.Occurrence) => Promise<Attention.Players>

/** No player: the TUI plays and shows everything itself. */
export const noPlayers: Attention.Players = { sound: false, desktop: false }

// An answer that takes longer (a service that switches releases, or is gone) leaves the TUI to do it all itself.
const ANSWER_MS = 1_000

export function createReport(api: () => OpenCodeClient, log: (message: string, tags: LogTags) => void): Report {
  return (occurrence) =>
    api()
      .experimental.attention.occurrence(occurrence, { signal: AbortSignal.timeout(ANSWER_MS) })
      .then(
        (players) => {
          log("attention occurrence reported", {
            kind: occurrence.kind,
            sessionID: occurrence.sessionID,
            ...summary(occurrence, players),
          })
          return players
        },
        (error: unknown) => {
          log("attention occurrence not reported", { kind: occurrence.kind, sessionID: occurrence.sessionID, error })
          return noPlayers
        },
      )
}

// What the TUI itself does with it, for the log.
function summary(occurrence: Attention.Occurrence, players: Attention.Players) {
  return {
    sound: occurrence.sound === undefined ? "none" : players.sound ? "player" : "own",
    notification: !occurrence.notify ? "none" : players.desktop ? "player" : "own",
  }
}
