import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid backup mapping");
  return value as Record<string, unknown>;
};
const normalized = (value: unknown): string => {
  if (typeof value !== "string" || value.includes("\0"))
    throw new Error("Invalid backup path");
  const result = value.replaceAll("\\", "/");
  if (result.split("/").some((part) => part === ".." || part === "."))
    throw new Error("Backup path traversal refused");
  return result.replace(/\/+$/, "");
};
const suffix = (file: string, root: string): string | null =>
  root && file.startsWith(root + "/") ? file.slice(root.length + 1) : null;
const relative = (value: string): string => {
  if (
    !value ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.includes(":"))
  )
    throw new Error("Invalid relative backup path");
  return value;
};

export interface LinuxRestoreOptions {
  sourceRoot: string;
  destinationRoot: string;
  artifactHome: string;
  artifactWinePrefix?: string | null;
  wineUserHome?: string;
  wine: boolean;
}

/** Paths from metadata may locate source files, but never select destination roots. */
export const planLinuxRestore = (
  mapping: unknown,
  options: LinuxRestoreOptions
) => {
  const manifest = record(mapping);
  const drives = Object.entries(record(manifest.drives))
    .map(([name, drive]) => {
      if (!/^drive-[a-zA-Z0-9_-]+$/.test(name))
        throw new Error("Invalid backup drive");
      return [name, normalized(drive)] as const;
    })
    .sort((a, b) => b[1].length - a[1].length);
  if (!Array.isArray(manifest.backups) || manifest.backups.length !== 1)
    throw new Error("Expected one full backup");
  const backup = record(manifest.backups[0]);
  if (backup.name !== undefined && backup.name !== ".")
    throw new Error("Unsupported incremental backup");
  if (Array.isArray(backup.children) && backup.children.length)
    throw new Error("Incremental backups require a full snapshot");
  const oldHome = normalized(options.artifactHome);
  const oldPrefix = normalized(options.artifactWinePrefix ?? "");
  const destinations = new Set<string>();
  return Object.keys(record(backup.files)).map((key) => {
    const file = normalized(key);
    const drive = drives.find(([, root]) =>
      root ? suffix(file, root) !== null : file.startsWith("/")
    );
    if (!drive)
      throw new Error("Backup file does not belong to a declared drive");
    const source = relative(
      drive[0] + "/" + (drive[1] ? suffix(file, drive[1])! : file.slice(1))
    );
    let destination: string;
    if (options.wine) {
      const prefixRelative = suffix(file, oldPrefix);
      const windows = prefixRelative?.startsWith("drive_c/")
        ? "C:/" + prefixRelative.slice(8)
        : file;
      const homeRelative = suffix(windows, oldHome);
      if (homeRelative !== null && options.wineUserHome) {
        const currentHome = normalized(options.wineUserHome);
        if (!/^C:\//i.test(currentHome))
          throw new Error("Invalid Wine user home");
        destination = "drive_c/" + currentHome.slice(3) + "/" + homeRelative;
      } else if (/^C:\//i.test(windows)) {
        destination = "drive_c/" + windows.slice(3);
      } else if (prefixRelative !== null) {
        destination = prefixRelative;
      } else {
        throw new Error("Backup destination is outside the game prefix");
      }
    } else {
      const homeRelative = suffix(file, oldHome);
      if (homeRelative === null)
        throw new Error("Native backup destination is outside the game home");
      destination = homeRelative;
    }
    destination = relative(destination);
    if (destinations.has(destination))
      throw new Error("Duplicate backup destination");
    destinations.add(destination);
    return { source, destination };
  });
};

// Python supplies openat/renameat through dir_fd. Every ancestor is pinned and
// opened O_NOFOLLOW; staged replacements never truncate a symlink/hardlink target.
// This worker runs only on Linux with the trusted system interpreter.
export const LINUX_RESTORE_WORKER = String.raw`
import json, os, shutil, stat, sys, uuid
plan = json.load(sys.stdin)
fds = []
staged = []
def directory(parent, name, create=False):
    if create:
        try: os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError: pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    fds.append(fd)
    return fd
def root(name):
    if not name.startswith('/') or any(p in ('.', '..') for p in name.split('/')):
        raise ValueError('invalid restore root')
    fd = directory(None, '/')
    for part in filter(None, name.split('/')): fd = directory(fd, part)
    return fd
def parts(name):
    result = name.split('/')
    if any(p in ('', '.', '..') for p in result): raise ValueError('invalid relative restore path')
    return result
try:
    source = root(plan['sourceRoot'])
    target = root(plan['destinationRoot'])
    pending = []
    for item in plan['files']:
        srcparts, dstparts = parts(item['source']), parts(item['destination'])
        srcparent, dstparent = source, target
        for part in srcparts[:-1]: srcparent = directory(srcparent, part)
        src = os.open(srcparts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=srcparent)
        fds.append(src)
        if not stat.S_ISREG(os.fstat(src).st_mode): raise ValueError('source is not a regular file')
        for part in dstparts[:-1]: dstparent = directory(dstparent, part, True)
        try:
            existing = os.stat(dstparts[-1], dir_fd=dstparent, follow_symlinks=False)
            if not stat.S_ISREG(existing.st_mode): raise ValueError('destination is not a regular file')
        except FileNotFoundError: pass
        pending.append((src, dstparent, dstparts[-1]))
    # Validate every path before staging any save contents or replacing files.
    for src, parent, name in pending:
        temp = '.hydra-restore-' + uuid.uuid4().hex
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        staged.append((parent, temp, name))
        with os.fdopen(os.dup(src), 'rb') as inp, os.fdopen(fd, 'wb') as out:
            shutil.copyfileobj(inp, out)
            out.flush()
            os.fsync(out.fileno())
    for parent, temp, name in staged:
        os.replace(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
finally:
    for parent, temp, name in staged:
        try: os.unlink(temp, dir_fd=parent)
        except FileNotFoundError: pass
    for fd in reversed(fds): os.close(fd)
`;

export const executeLinuxRestore = async (
  options: LinuxRestoreOptions,
  files: ReturnType<typeof planLinuxRestore>
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      ["-I", "-c", LINUX_RESTORE_WORKER],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["pipe", "ignore", "pipe"],
        timeout: 120000,
        killSignal: "SIGKILL",
      }
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      if (stderr.length < 8192) stderr += data;
    });
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Safe backup restore refused: ${stderr}`))
    );
    child.stdin.end(
      JSON.stringify({
        sourceRoot: options.sourceRoot,
        destinationRoot: options.destinationRoot,
        files,
      })
    );
  });
};

export const restoreLinuxBackup = async (
  options: LinuxRestoreOptions
): Promise<void> => {
  const mappingPath = path.join(options.sourceRoot, "mapping.yaml");
  const mappingFd = fs.openSync(
    mappingPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  let mapping: unknown;
  try {
    mapping = YAML.parse(fs.readFileSync(mappingFd, "utf8"));
  } finally {
    fs.closeSync(mappingFd);
  }
  const files = planLinuxRestore(mapping, options);
  await executeLinuxRestore(options, files);
};
