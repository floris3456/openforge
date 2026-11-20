export * as PictureRemoved from "./picture-removed.js"

// openforge (spec pictures-files): what stands where a picture was once its chat went untouched for 30 days, for the
// model and the TUI alike. In util, so the TUI recognizes it without loading core.

/** The same bytes every time, so a chat's cache holds from its first request after the removal on. */
export const text = "[Picture removed: this chat was untouched for 30 days.]"

/** A person's attached picture becomes a text attachment holding {@link text}, in Base64. */
export const data = btoa(text)

/** Whether a tool result's text item, or a text attachment's Base64, is the placeholder. */
export const is = (value: string) => value === text || value === data
