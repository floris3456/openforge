import { RGBA } from "@opentui/core"
import { usePacer } from "../context/pacer"
import { readable } from "../theme/readable"

// openforge (the workspace's spec docs/specs/agent-badges.md, section 3, item 3): where a chat's title shows, a chat with
// an identity has its title in its badge scheme's background colour, readable on what it is drawn on. The colour is the
// agent's, from CLIProxyPacer, not one of the theme's: the theme gives the surface, which each place passes.

/**
 * A chat's title colour on `background`; undefined for no chat, a chat without an identity, or no CPP with badges, where
 * its place keeps its own colour.
 */
export function useTitleColour() {
  const pacer = usePacer()
  return (sessionID: string | undefined, background: RGBA) => {
    const badge = sessionID === undefined ? undefined : pacer?.badge(sessionID)
    return badge ? readable(RGBA.fromHex(badge.background), background) : undefined
  }
}
