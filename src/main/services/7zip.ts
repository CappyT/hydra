import { app } from "electron";
import Seven, { CommandLineSwitches } from "node-7z";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";
import { resolveSystemBinary } from "@main/helpers/resolve-system-binary";
import { listArchiveEntries, readArchiveEntry } from "./archive-entry";
import {
  createSevenZipSandbox,
  removeEscapingSymlinksLogged,
} from "./extraction-hardening";
import { listArchiveVolumes } from "./extraction-sandbox";

export const binaryName = {
  linux: "7zzs",
  darwin: "7zz",
  win32: "7z.exe",
};

export interface ExtractionProgress {
  percent: number;
  fileCount: number;
  file: string;
}

export interface ExtractionResult {
  success: boolean;
  extractedFiles: string[];
}

export class SevenZip {
  private static readonly binaryPath = SevenZip.resolveBinaryPath();

  // Prefer the official 7-Zip provided by the system (Fedora ships `7z`, other
  // distros the standalone `7zz`); both are argument-compatible with the bundled
  // static `7zzs`. Fall back to the copy fetched into binaries/ at build time.
  private static resolveBinaryPath(): string {
    const systemBinary = resolveSystemBinary(["7zz", "7z"]);
    if (systemBinary) return systemBinary;

    return app.isPackaged
      ? path.join(process.resourcesPath, binaryName[process.platform])
      : path.join(
          __dirname,
          "..",
          "..",
          "binaries",
          binaryName[process.platform]
        );
  }

  public static listEntries(filePath: string, signal?: AbortSignal) {
    return listArchiveEntries(this.binaryPath, filePath, signal);
  }

  public static readEntry(
    filePath: string,
    entryName: string,
    maxBytes: number,
    signal?: AbortSignal
  ) {
    return readArchiveEntry(
      this.binaryPath,
      filePath,
      entryName,
      maxBytes,
      signal
    );
  }

  private static isPasswordRelatedError(error: unknown): boolean {
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    const normalizedMessage = errorMessage.toLowerCase();

    return (
      normalizedMessage.includes("wrong password") ||
      normalizedMessage.includes("can not open encrypted archive") ||
      normalizedMessage.includes("encrypted")
    );
  }

  public static async extractFile(
    {
      filePath,
      outputPath,
      cwd,
      passwords = [],
    }: {
      filePath: string;
      outputPath?: string;
      cwd?: string;
      passwords?: string[];
    },
    onProgress?: (progress: ExtractionProgress) => void
  ): Promise<ExtractionResult> {
    const destination = outputPath ?? cwd ?? process.cwd();

    await fs.promises.mkdir(destination, { recursive: true });

    const sandbox = createSevenZipSandbox({
      binds: [
        ...listArchiveVolumes(path.resolve(destination, filePath)).map(
          (volume) => ({ path: volume, writable: false })
        ),
        { path: destination, writable: true },
      ],
      chdir: destination,
    });
    await removeEscapingSymlinksLogged(destination);

    return new Promise<ExtractionResult>((resolve, reject) => {
      let settled = false;
      let activeAttempt = 0;

      const tryPassword = (index = 0) => {
        const attemptId = ++activeAttempt;
        const password = passwords[index] ?? "";
        logger.info(
          `Trying password "${password || "(empty)"}" on ${filePath}`
        );

        const extractedFiles: string[] = [];
        let fileCount = 0;

        const options: CommandLineSwitches = {
          $bin: this.binaryPath,
          $progress: true,
          $defer: true,
          yes: true,
          noWildcards: true,
          password: password || undefined,
        };

        const stream = Seven.extractFull(filePath, ".", options);
        const command = sandbox(stream._bin, stream._args);

        stream._childProcess = spawn(command.command, command.args, {
          cwd: destination,
          detached: true,
          windowsHide: true,
        });

        stream.on("progress", (progress) => {
          if (onProgress) {
            onProgress({
              percent: progress.percent,
              fileCount: fileCount,
              file: progress.fileCount?.toString() || "",
            });
          }
        });

        stream.on("data", (data) => {
          if (data.file) {
            extractedFiles.push(data.file);
            fileCount++;
          }
        });

        stream.on("end", () => {
          if (settled || attemptId !== activeAttempt) {
            return;
          }

          settled = true;
          logger.info(
            `Successfully extracted ${filePath} (${extractedFiles.length} files)`
          );
          resolve({
            success: true,
            extractedFiles,
          });
        });

        stream.on("error", (err) => {
          if (settled || attemptId !== activeAttempt) {
            return;
          }

          logger.error(`Extraction error for ${filePath}:`, err);

          const shouldTryNextPassword =
            index < passwords.length - 1 && this.isPasswordRelatedError(err);

          if (shouldTryNextPassword) {
            logger.info(
              `Failed to extract file: ${filePath} with password: "${password}". Trying next password...`
            );
            removeEscapingSymlinksLogged(destination).then(
              () => tryPassword(index + 1),
              (error) => {
                settled = true;
                reject(error);
              }
            );
          } else {
            settled = true;
            logger.error(
              `Failed to extract file: ${filePath} after trying all passwords`
            );
            reject(new Error(`Failed to extract file: ${filePath}`));
          }
        });

        Seven.listen(stream);
      };

      tryPassword(0);
    }).finally(() => removeEscapingSymlinksLogged(destination));
  }

  public static async createZip({
    sourcePath,
    destinationPath,
    signal,
  }: {
    sourcePath: string;
    destinationPath: string;
    signal?: AbortSignal;
  }): Promise<void> {
    signal?.throwIfAborted();
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    signal?.throwIfAborted();

    const sandbox = createSevenZipSandbox({
      binds: [
        {
          path: path.dirname(path.resolve(sourcePath, destinationPath)),
          writable: true,
        },
        { path: sourcePath, writable: false },
      ],
      chdir: sourcePath,
    });

    return new Promise((resolve, reject) => {
      const options: CommandLineSwitches = {
        $bin: this.binaryPath,
        $defer: true,
        yes: true,
        recursive: true,
        noWildcards: true,
      };

      const stream = Seven.add(destinationPath, ".", options);
      const command = sandbox(stream._bin, stream._args);

      const childProcess = spawn(command.command, command.args, {
        cwd: sourcePath,
        windowsHide: true,
      });
      stream._childProcess = childProcess;

      let settled = false;
      let abortRequested = false;

      const abortReason = () =>
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("ZIP creation aborted", "AbortError");

      const settle = (error?: unknown) => {
        if (settled) return;

        settled = true;
        signal?.removeEventListener("abort", onAbort);

        if (error) reject(error);
        else resolve();
      };

      const onAbort = () => {
        if (abortRequested || settled) return;

        abortRequested = true;
        try {
          childProcess.kill();
        } catch (error) {
          settle(error);
        }
      };

      stream.on("end", () =>
        settle(abortRequested ? abortReason() : undefined)
      );
      stream.on("error", (error) =>
        settle(abortRequested ? abortReason() : error)
      );
      Seven.listen(stream);

      signal?.addEventListener("abort", onAbort, { once: true });

      if (signal?.aborted) onAbort();
    });
  }

  public static listFiles(
    filePath: string,
    password?: string
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const files: string[] = [];

      const options: CommandLineSwitches = {
        $bin: this.binaryPath,
        $defer: true,
        noWildcards: true,
        password: password || undefined,
      };

      const archivePath = path.resolve(filePath);
      const stream = Seven.list(archivePath, options);
      const command = createSevenZipSandbox({
        binds: listArchiveVolumes(archivePath).map((volume) => ({
          path: volume,
          writable: false,
        })),
        chdir: path.dirname(archivePath),
      })(stream._bin, stream._args);

      stream._childProcess = spawn(command.command, command.args, {
        windowsHide: true,
      });

      stream.on("data", (data) => {
        if (data.file) {
          files.push(data.file);
        }
      });

      stream.on("end", () => {
        resolve(files);
      });

      stream.on("error", (err) => {
        reject(err);
      });

      Seven.listen(stream);
    });
  }
}
