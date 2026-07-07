export const launchedGamePids = new Map<string, number>();

/**
 * Game keys whose launched pid refers to a bubblewrap sandbox wrapper. Closing
 * such a game must kill the whole process group so the sandbox tears down.
 */
export const sandboxedGamePids = new Set<string>();
