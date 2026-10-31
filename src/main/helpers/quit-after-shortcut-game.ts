// Steam Deck gaming mode: a per-game Steam shortcut cold-starts Hydra with a
// run deep link. Steam shows the shortcut as running until the Hydra process
// exits, so Hydra must quit once that one game exits.
let quitAfterGameKey: string | null = null;
let quitApp: (() => void) | null = null;

export const markQuitAfterGameExit = (gameKey: string, quit: () => void) => {
  quitAfterGameKey = gameKey;
  quitApp = quit;
};

export const shouldQuitAfterGameExit = (gameKey: string) =>
  quitAfterGameKey === gameKey;

export const clearQuitAfterGameExit = () => {
  quitAfterGameKey = null;
  quitApp = null;
};

/**
 * Quits only for the marked game, and only after the close work (playtime
 * write, close-backup) settled, so quitting never cuts the backup short.
 * Returns true when it quit.
 */
export const quitAfterGameExit = async (
  gameKey: string,
  closeWork: Array<Promise<unknown> | undefined>,
  options: { othersRunning?: boolean; sandboxPid?: number } = {}
) => {
  if (!shouldQuitAfterGameExit(gameKey) || !quitApp) return false;

  const quit = quitApp;
  clearQuitAfterGameExit();
  // The user started another game from Hydra's own UI: keep Hydra open.
  if (options.othersRunning) return false;
  await Promise.allSettled(closeWork);
  // A missed process match must not quit while the sandbox still runs the
  // game: --die-with-parent would kill it.
  if (options.sandboxPid !== undefined)
    await waitForPidExit(options.sandboxPid);
  quit();

  return true;
};

const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const waitForPidExit = async (pid: number, intervalMs = 1000) => {
  while (isPidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
