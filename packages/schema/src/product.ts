export * as Product from "./product.js"

// openforge's own names for what the user sees: the command, its folders and the name on screen. Internal names stay
// upstream's: the @opencode/* packages, OPENCODE_* variables, opencode.json and .opencode/.

/** The command users type. */
export const binary = "openforge"
/**
 * The folder under each XDG base directory (config, data, cache, state, tmp) and the system config directory, and,
 * with a dot, the one in the home folder that holds the plan agent's plans (`~/.openforge/plan`).
 */
export const folder = "openforge"
/** The name on screen. */
export const name = "openforge"
/** The name in terminal titles before a session title. */
export const short = "OF"
/** The GitHub repository that holds the releases and the issues. */
export const repository = "floris3456/openforge"
/**
 * The macOS managed-preferences domain, which device management deploys as `<domain>.plist` under
 * `/Library/Managed Preferences`: reverse DNS of the repository, as openforge has no domain of its own.
 */
export const preferences = "io.github.floris3456.openforge.managed"
