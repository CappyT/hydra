/*
 * Accountless fork: embeds AppImage "update information" (the standard
 * `.upd_info` ELF section read by Gear Lever / AppImageUpdate / appimaged)
 * into an electron-builder AppImage, then rewrites the sha512/size in the
 * sibling latest-linux.yml so the in-app electron-updater still accepts the
 * patched file.
 *
 * electron-builder has no option for this; its runtime ships the standard
 * zero-filled 1024-byte `.upd_info` section, so writing the string in place
 * is exactly what appimagetool would have done at build time.
 *
 * Usage: node scripts/embed-appimage-update-info.mjs <file.AppImage> <update-string>
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [appImagePath, updateString] = process.argv.slice(2);

if (!appImagePath || !updateString) {
  console.error(
    "usage: embed-appimage-update-info.mjs <file.AppImage> <update-string>"
  );
  process.exit(1);
}

const findUpdInfoSection = (filePath) => {
  const output = execFileSync("readelf", ["-S", "-W", filePath], {
    encoding: "utf8",
    // The section header table sits at the start; readelf only reads headers.
    maxBuffer: 1024 * 1024,
  });

  // e.g. "  [27] .upd_info  PROGBITS  0000000000000000 02ae68 000400 00   A  0  0  1"
  const line = output.split("\n").find((entry) => entry.includes(".upd_info"));
  if (!line) return null;

  const columns = line
    .replace(/^.*\.upd_info\s+\w+\s+/, "")
    .trim()
    .split(/\s+/);
  const offset = Number.parseInt(columns[1], 16);
  const size = Number.parseInt(columns[2], 16);
  if (!Number.isFinite(offset) || !Number.isFinite(size)) return null;

  return { offset, size };
};

const section = findUpdInfoSection(appImagePath);
if (!section) {
  console.error(`no .upd_info section found in ${appImagePath}`);
  process.exit(1);
}

const payload = Buffer.from(updateString, "utf8");
if (payload.length >= section.size) {
  console.error(
    `update string (${payload.length} bytes) does not fit .upd_info (${section.size} bytes)`
  );
  process.exit(1);
}

// Zero the whole section first, then write the NUL-terminated string.
const zeroed = Buffer.alloc(section.size);
payload.copy(zeroed);

const fd = fs.openSync(appImagePath, "r+");
try {
  fs.writeSync(fd, zeroed, 0, zeroed.length, section.offset);
} finally {
  fs.closeSync(fd);
}

console.log(
  `embedded update info at 0x${section.offset.toString(16)}: ${updateString}`
);

// Re-align latest-linux.yml with the patched file, if it sits next to it.
const distDir = path.dirname(appImagePath);
const latestYmlPath = path.join(distDir, "latest-linux.yml");

if (fs.existsSync(latestYmlPath)) {
  const fileBuffer = fs.readFileSync(appImagePath);
  const sha512 = crypto
    .createHash("sha512")
    .update(fileBuffer)
    .digest("base64");
  const size = fileBuffer.length;

  const updated = fs
    .readFileSync(latestYmlPath, "utf8")
    .replace(/sha512: .*/g, `sha512: ${sha512}`)
    .replace(/size: .*/g, `size: ${size}`);

  fs.writeFileSync(latestYmlPath, updated);
  console.log(`updated ${latestYmlPath} (sha512/size recomputed)`);
} else {
  console.log("latest-linux.yml not found next to the AppImage, skipped");
}
