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

const isControllerNode = (file: string): boolean => {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isCharacterDevice()) return false;
    const dev = stat.rdev;
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
    const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
    return isControllerProperties(
      fs.readFileSync(`/run/udev/data/c${major}:${minor}`, "utf8")
    );
  } catch {
    return false;
  }
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
