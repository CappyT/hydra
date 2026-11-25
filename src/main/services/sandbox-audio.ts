/**
 * Filtered PulseAudio endpoint for sandboxed games.
 *
 * The session PipeWire and PulseAudio sockets give a client the whole audio
 * server: it records the microphone, loads modules into the server and sees
 * the streams of other programs. A game without the microphone permission gets
 * a socket of a second `pipewire-pulse` instance instead. That instance is a
 * plain client of the session PipeWire and runs outside the sandbox with this
 * configuration:
 *   - `pulse.allow-module-loading = false`;
 *   - every client gets the `block-record-stream` quirk, so no capture stream
 *     (microphone or sink monitor) can be created;
 *   - sink and source volume changes are blocked.
 * Playback is untouched. The rule matches on `client.api` in every state
 * (expected value, other value, absent), so a client cannot dodge it by
 * sending its own properties.
 *
 * Electron-free: the caller supplies the directory and the binaries.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export const FILTERED_PULSE_CONFIG = `context.properties = { }
context.spa-libs = {
    audio.convert.* = audioconvert/libspa-audioconvert
    support.*       = support/libspa-support
}
context.modules = [
    { name = libpipewire-module-rt
        args = { nice.level = -11 rtportal.enabled = false }
        flags = [ ifexists nofail ]
    }
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-adapter }
    { name = libpipewire-module-metadata }
    { name = libpipewire-module-protocol-pulse args = { } }
]
pulse.properties = {
    server.address = [ "unix:native" ]
    pulse.allow-module-loading = false
}
pulse.rules = [
    {
        matches = [
            { client.api = "pipewire-pulse" }
            { client.api = "!pipewire-pulse" }
            { client.api = null }
        ]
        actions = {
            quirks = [ block-record-stream block-source-volume block-sink-volume ]
        }
    }
]
`;

export interface FilteredPulseOptions {
  /** Launcher-owned directory for the config, the socket and the pid file. */
  directory: string;
  /** `$XDG_RUNTIME_DIR` of the session; holds the PipeWire socket. */
  runtimeDir: string;
  pipewirePulsePath: string;
  /** When set, the instance dies with the launcher (`--pdeathsig`). */
  setprivPath?: string | null;
  home?: string;
}

const SOCKET_WAIT_MS = 3000;

let instance: { child: ChildProcess; socketPath: string } | null = null;

const isSocket = (file: string): boolean => {
  try {
    return fs.statSync(file).isSocket();
  } catch {
    return false;
  }
};

const sleepSync = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

/** Starts the instance when none is alive. Returns the socket path it serves. */
export const startFilteredPulse = (options: FilteredPulseOptions): string => {
  if (instance && instance.child.exitCode === null && !instance.child.killed) {
    return instance.socketPath;
  }

  const { directory, runtimeDir, pipewirePulsePath, setprivPath, home } =
    options;
  const configPath = path.join(directory, "hydra-sandbox-pulse.conf");
  const socketPath = path.join(directory, "native");

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, FILTERED_PULSE_CONFIG);
  // A socket left by a launcher that crashed has no server behind it.
  fs.rmSync(socketPath, { force: true });

  const pulseArgs = ["-c", configPath];
  const [command, args] = setprivPath
    ? [
        setprivPath,
        ["--pdeathsig", "TERM", "--", pipewirePulsePath, ...pulseArgs],
      ]
    : [pipewirePulsePath, pulseArgs];

  const child = spawn(command, args, {
    stdio: "ignore",
    env: {
      PATH: "/usr/bin:/bin",
      ...(home ? { HOME: home } : {}),
      XDG_RUNTIME_DIR: runtimeDir,
      PULSE_RUNTIME_PATH: directory,
      PIPEWIRE_REMOTE: path.join(runtimeDir, "pipewire-0"),
    },
  });
  child.once("error", () => {
    if (instance?.child === child) instance = null;
  });
  child.once("exit", () => {
    if (instance?.child === child) instance = null;
  });
  instance = { child, socketPath };
  return socketPath;
};

/**
 * Returns the socket of a live filtered instance, starting it when needed and
 * waiting a bounded time for the socket. Throws when no socket appears: the
 * caller must not fall back to the unfiltered session sockets.
 */
export const ensureFilteredPulseSocket = (
  options: FilteredPulseOptions
): string => {
  const socketPath = startFilteredPulse(options);
  const deadline = Date.now() + SOCKET_WAIT_MS;
  while (!isSocket(socketPath)) {
    if (!instance || Date.now() > deadline) {
      stopFilteredPulse();
      throw new Error("filtered PulseAudio socket did not appear");
    }
    sleepSync(25);
  }
  return socketPath;
};

export const stopFilteredPulse = (): void => {
  const current = instance;
  instance = null;
  current?.child.kill("SIGTERM");
};
