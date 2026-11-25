import fs from "node:fs";
import path from "node:path";

/** udev is authoritative; composite keyboard/mouse devices must not be exposed. */
export const isControllerProperties = (properties: string): boolean => {
  const flags = new Set(
    properties.split("\n").map((line) => line.replace(/^E:/, "").trim())
  );
  return (
    flags.has("ID_INPUT_JOYSTICK=1") &&
    !flags.has("ID_INPUT_KEYBOARD=1") &&
    !flags.has("ID_INPUT_MOUSE=1")
  );
};

/** udev's v4l_id marks capture-capable video nodes; metadata nodes lack it. */
export const isCameraProperties = (properties: string): boolean =>
  properties
    .split("\n")
    .map((line) => line.replace(/^E:/, "").trim())
    .some(
      (flag) =>
        flag.startsWith("ID_V4L_CAPABILITIES=") && flag.includes(":capture:")
    );

const readUdevProperties = (file: string): string | null => {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isCharacterDevice()) return null;
    const dev = stat.rdev;
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
    const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
    return fs.readFileSync(`/run/udev/data/c${major}:${minor}`, "utf8");
  } catch {
    return null;
  }
};

const isControllerNode = (file: string): boolean => {
  const properties = readUdevProperties(file);
  return properties !== null && isControllerProperties(properties);
};

/** Bind individual verified controller nodes, never the host input directory. */
export const listSandboxInputDevices = (): string[] => {
  const devices: string[] = [];
  for (const [directory, pattern] of [
    ["/dev/input", /^(event|js)\d+$/],
    ["/dev", /^hidraw\d+$/],
  ] as const) {
    try {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        if (pattern.test(name) && isControllerNode(file)) devices.push(file);
      }
    } catch {
      /* No input subsystem on headless hosts. */
    }
  }
  return devices;
};

/** V4L2 capture nodes, for games that hold the camera permission. */
export const listSandboxCameraDevices = (): string[] => {
  try {
    return fs
      .readdirSync("/dev")
      .filter((name) => /^video\d+$/.test(name))
      .map((name) => path.join("/dev", name))
      .filter((file) => {
        const properties = readUdevProperties(file);
        return properties !== null && isCameraProperties(properties);
      });
  } catch {
    return [];
  }
};
