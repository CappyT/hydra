import { constants, promises as fs } from "node:fs";

/**
 * File access for paths the sandboxed port can write. A link or a FIFO the
 * port planted there must not redirect a launcher write to a host file, or
 * stall a launcher read: every open refuses a final symlink (O_NOFOLLOW),
 * never blocks (O_NONBLOCK) and accepts only a regular file. Callers also run
 * the folder sanitizer before writing, which covers links in parent folders.
 */
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

/**
 * Trophy files, markers and configs are small. A larger file (a sparse one
 * included) is refused, so a read cannot exhaust the launcher's memory.
 */
const MAX_READ_BYTES = 64 * 1024 * 1024;

const refuse = (message: string, file: string) =>
  Object.assign(new Error(`${message}: ${file}`), { code: "EINVAL" });

const openRegular = async (file: string, flags: number, maxSize?: number) => {
  const handle = await fs.open(file, flags, 0o644);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw refuse("Not a regular file", file);
    if (maxSize !== undefined && stats.size > maxSize) {
      throw refuse("File too large", file);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

function readFile(file: string): Promise<Buffer>;
function readFile(file: string, encoding: BufferEncoding): Promise<string>;
async function readFile(file: string, encoding?: BufferEncoding) {
  const handle = await openRegular(file, READ_FLAGS, MAX_READ_BYTES);
  try {
    const data = await handle.readFile();
    return encoding ? data.toString(encoding) : data;
  } finally {
    await handle.close();
  }
}

const writeFile = async (file: string, data: string | Uint8Array) => {
  const handle = await openRegular(file, WRITE_FLAGS);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
};

/** Opens for reading only; the flags argument of `fs.open` is ignored. */
const open = (file: string, _flags?: string) =>
  openRegular(file, READ_FLAGS, MAX_READ_BYTES);

export const portFs = {
  open,
  readFile,
  writeFile,
  // lstat: a planted link must not make the launcher look at its target.
  stat: fs.lstat,
  // rm unlinks a link itself and never follows it.
  rm: fs.rm,
};
