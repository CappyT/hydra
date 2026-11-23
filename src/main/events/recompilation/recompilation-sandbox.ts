import { dialog } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { UserPreferences } from "@types";
import { sandboxHomesPath } from "@main/constants";
import { db, levelKeys } from "@main/level";
import { Sandbox, SandboxUnavailableError } from "@main/services";
import { resolveLaunchCommand } from "@main/helpers/resolve-launch-command";
import {
  closeSeccompFd,
  openSeccompFd,
  withSeccompStdio,
  wrapWithSandbox,
  type SeccompStdioEntry,
} from "@main/helpers/sandbox-launch";
import { buildSandboxEnv } from "@main/helpers/sandbox-env";
import { assertSafeSandboxPath, within } from "@main/helpers/sandbox-paths";
import recompilationMeta from "./recompilation-meta.json";
import {
  getRecompilationBaseDirectory,
  getRecompilationInstallDirectory,
  resolveRecompilationPath,
} from "./recompilation-paths";
import {
  getPortPathTemplates,
  getRecompilationSandboxPaths,
  listRomFiles,
  removeEscapingSymlinks,
} from "./recompilation-sandbox-paths";
import {
  assertSandboxCanStart,
  trackLiveSandbox,
  whileSandboxQuiet,
} from "./recompilation-sandbox-locks";

export { RecompilationSandboxBusyError } from "./recompilation-sandbox-locks";

/**
 * A recompiled port is a native binary that the Hydra API picks from a GitHub
 * release, so it runs under the same bwrap sandbox as every game. Emulators
 * stay exempt; ports do not.
 */
export interface RecompilationSandbox {
  /** Persistent per-port home; null runs with an ephemeral home. */
  gameKey: string | null;
  installDirectory: string;
  userPreferences: UserPreferences | null;
  binds: string[];
  roBinds: string[];
}

/**
 * Resolves the binds of a port launch. Throws a SandboxUnavailableError when a
 * ROM file is a path the sandbox refuses (a home folder secret, for example).
 */
export const prepareRecompilationSandbox = async (
  slug: string,
  installDirectory: string,
  romPath?: string | null
): Promise<RecompilationSandbox> => {
  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);
  const baseDirectory = await getRecompilationBaseDirectory(installDirectory);

  const { binds, roBinds } = getRecompilationSandboxPaths(
    installDirectory,
    getPortPathTemplates(
      (recompilationMeta as Record<string, unknown>)[slug]
    ).map((template) => resolveRecompilationPath(template, baseDirectory)),
    romPath ? await listRomFiles(romPath) : []
  );
  if (Sandbox.isEnabled(userPreferences, null)) {
    // wrapWithSandbox checks only writable binds; a ROM bind gets the same
    // rules. Writable binds are checked here too, before the mkdir below.
    for (const file of [...binds, ...roBinds]) {
      assertSafeSandboxPath(
        file,
        process.env.HOME || "/home",
        path.dirname(sandboxHomesPath)
      );
    }
  }
  // bwrap needs each bind source to exist; the port expects these folders anyway.
  for (const directory of binds) fs.mkdirSync(directory, { recursive: true });

  return {
    gameKey: `recompilation:${slug}`,
    installDirectory,
    userPreferences,
    binds,
    roBinds,
  };
};

export interface SandboxedRecompilationSpawnOptions {
  cwd: string;
  /** Inherited environment; scrubbed to the sandbox allowlist when sandboxed. */
  baseEnv: NodeJS.ProcessEnv;
  /** Variables the port's launch needs; set only on the final exec in the sandbox. */
  launchEnv?: Record<string, string>;
  stdio: [SeccompStdioEntry, SeccompStdioEntry, SeccompStdioEntry];
  detached?: boolean;
}

const getWritableRoots = (sandbox: RecompilationSandbox) => [
  sandbox.installDirectory,
  ...sandbox.binds,
];

/**
 * Removes links the port planted towards writable host paths in the folders
 * it can write, before the launcher writes there. No-op when the sandbox is off.
 */
export const sanitizeRecompilationFolders = async (
  sandbox: RecompilationSandbox
) => {
  if (!Sandbox.isEnabled(sandbox.userPreferences, null)) return;
  const roots = getWritableRoots(sandbox);
  await whileSandboxQuiet(roots, async () => {
    for (const root of roots) await removeEscapingSymlinks(root);
  });
};

/**
 * The sandbox for a release that unpacks itself (an AppImage run with
 * `--appimage-extract`): the port's home, the staging folder writable and the
 * downloaded release read-only.
 */
export const prepareExtractionSandbox = async (
  slug: string,
  stagingDirectory: string,
  archivePath: string
): Promise<RecompilationSandbox> => ({
  // The port's own key: the release comes from the same source as the port,
  // and the key gives it the spoofed machine-id.
  gameKey: `recompilation:${slug}`,
  installDirectory: stagingDirectory,
  userPreferences: await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null),
  binds: [],
  roBinds: [archivePath],
});

/**
 * Sanitizes the install folder and every bind of a port, then runs
 * `operation` (a launcher write there) before a sandbox of the port can start.
 * Throws RecompilationSandboxBusyError while a process of the port runs.
 */
export const withSanitizedPort = async <T>(
  slug: string,
  operation: () => Promise<T>
): Promise<T> => {
  const installDirectory = await getRecompilationInstallDirectory(slug);
  await sanitizeRecompilationInstall(installDirectory);
  const sandbox = await prepareRecompilationSandbox(slug, installDirectory);
  return whileSandboxQuiet(getWritableRoots(sandbox), async () => {
    await sanitizeRecompilationFolders(sandbox);
    return operation();
  });
};

/** Same as sanitizeRecompilationFolders, for the install folder before an update. */
export const sanitizeRecompilationInstall = async (
  installDirectory: string
) => {
  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);
  if (Sandbox.isEnabled(userPreferences, null)) {
    await whileSandboxQuiet([installDirectory], () =>
      removeEscapingSymlinks(installDirectory)
    );
  }
};

/** Shows why the sandbox refused a port launch, as game launches do. */
export const reportRecompilationSandboxError = (error: unknown) => {
  if (error instanceof SandboxUnavailableError) {
    dialog.showErrorBox("Hydra", error.message);
  }
};

/** Spawns a port binary through the sandbox. Throws when the sandbox is unavailable. */
export const spawnSandboxedRecompilation = (
  sandbox: RecompilationSandbox,
  command: string,
  args: string[],
  options: SandboxedRecompilationSpawnOptions
): ChildProcess => {
  const roots = getWritableRoots(sandbox);
  assertSandboxCanStart(roots);
  const sandboxEnabled = Sandbox.isEnabled(sandbox.userPreferences, null);
  const base = resolveLaunchCommand({ baseCommand: command, baseArgs: args });
  const resolved = wrapWithSandbox(
    { ...base, env: { ...base.env, ...options.launchEnv } },
    {
      userPreferences: sandbox.userPreferences,
      game: null,
      gameKey: sandbox.gameKey,
      gameDir: sandbox.installDirectory,
      additionalBinds: sandbox.binds,
      additionalRoBinds: sandbox.roBinds,
    }
  );

  const seccompFd = openSeccompFd(resolved);
  try {
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd,
      env: {
        ...(sandboxEnabled
          ? buildSandboxEnv(options.baseEnv)
          : options.baseEnv),
        ...resolved.env,
      },
      stdio: withSeccompStdio(options.stdio, seccompFd),
      detached: options.detached ?? false,
      shell: false,
    });
    trackLiveSandbox(child, roots);
    return child;
  } finally {
    // The child inherited its own dup at fd 3; closing this copy is safe.
    closeSeccompFd(seccompFd);
  }
};

const readProcText = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const readChildPids = (pid: number) =>
  readProcText(`/proc/${pid}/task/${pid}/children`)
    .split(/\s+/)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((childPid) => Number.isInteger(childPid) && childPid > 0);

const readExe = (pid: number) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return "";
  }
};

/** True when `pid` is a bwrap wrapper, so the port runs in its own pid namespace. */
export const isSandboxWrapperProcess = (pid: number) =>
  path.basename(readExe(pid)) === "bwrap";

/**
 * Closes a sandboxed port: SIGTERM to the port's own processes, SIGKILL to the
 * whole sandbox after `graceMs`. The bwrap wrapper, the network wrapper and
 * pasta never get the SIGTERM: any of them exiting tears the namespace down
 * with SIGKILL, before the port can save.
 */
export const terminateSandboxedRecompilation = async (
  wrapper: ChildProcess & { pid: number },
  installDirectory: Promise<string> | string,
  graceMs: number
) => {
  const wrapperPid = wrapper.pid;
  const timer = setTimeout(() => Sandbox.killSandboxTree(wrapperPid), graceMs);
  timer.unref();
  // A pid reused after a clean exit must not get the SIGKILL.
  wrapper.once("exit", () => clearTimeout(timer));

  const directory = path.resolve(await installDirectory);
  // /proc shows the bound path as launched, which may differ from its realpath.
  const roots = [
    directory,
    await fs.promises.realpath(directory).catch(() => directory),
  ];

  const pending = readChildPids(wrapperPid);
  while (pending.length > 0) {
    const pid = pending.pop()!;
    pending.push(...readChildPids(pid));

    const [argv0, argv1] = readProcText(`/proc/${pid}/cmdline`).split("\0");
    const isPortProcess = [readExe(pid), argv0, argv1].some(
      (candidate) =>
        candidate &&
        path.isAbsolute(candidate) &&
        roots.some((root) => within(root, candidate))
    );
    if (!isPortProcess) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
};
