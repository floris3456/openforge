export * as Product from "./product.js"

// openforge's own names for what the user sees: the command, its folders and the name on screen. Internal names stay
// upstream's: the @opencode/* packages, OPENCODE_* variables, opencode.json and .opencode/.

/** The command users type. */
export const binary = "openforge"
/** The folder under each XDG base directory (config, data, cache, state, tmp) and the system config directory. */
export const folder = "openforge"
/** The name on screen. */
export const name = "openforge"
/** The name in terminal titles before a session title. */
export const short = "OF"
/** The GitHub repository that holds the releases and the issues. */
export const repository = "floris3456/openforge"
