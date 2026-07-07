const { default: axios } = require("axios");
const crypto = require("node:crypto");
const util = require("node:util");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const exec = util.promisify(require("node:child_process").exec);

const ROOT = process.cwd();
const BINARIES_DIR = path.join(ROOT, "binaries");
const LUDUSAVI_DIR = path.join(ROOT, "ludusavi");

// This fork builds for linux x86_64 only. Every third-party binary is fetched
// exclusively from its official upstream release channel and verified against a
// sha256 pinned below. No mirrors, no committed blobs, and no unverified
// downloads: an unknown platform/arch fails closed.
const PLATFORM_KEY = `${process.platform}-${process.arch}`;

const UMU_VERSION = "1.4.1";
const LUDUSAVI_VERSION = "0.29.0";
const SEVEN_ZIP_VERSION = "26.02";

/**
 * @typedef {Object} Component
 * @property {string} name
 * @property {string} installedPath   final on-disk location of the binary
 * @property {string} installedSha256 sha256 of the installed binary (skip check)
 * @property {Record<string, { url: string, sha256: string }>} assets
 * @property {(assetPath: string) => Promise<void>} install
 */

/** @type {Component[]} */
const components = [
  {
    name: "umu-run",
    installedPath: path.join(BINARIES_DIR, "umu", "umu-run"),
    installedSha256:
      "ecb44854bf16b87d08ba101da3459ac4f02f3ccf8bf40a8ac6ea3143446bccf8",
    // Open-Wine-Components/umu-launcher official release (arch-independent zipapp).
    assets: {
      "linux-x64": {
        url: `https://github.com/Open-Wine-Components/umu-launcher/releases/download/${UMU_VERSION}/umu-launcher-${UMU_VERSION}-zipapp.tar`,
        sha256:
          "97b6ff2981912a6b9cd223ec4fb5c4e0a819e5c166811e0f82ae60fad0801c21",
      },
    },
    install: async (assetPath) => {
      fs.mkdirSync(BINARIES_DIR, { recursive: true });
      // The tarball contains umu/umu-run (the zipapp); extract just that.
      await exec(
        `tar -xf ${quote(assetPath)} -C ${quote(BINARIES_DIR)} umu/umu-run`
      );
      fs.chmodSync(path.join(BINARIES_DIR, "umu", "umu-run"), 0o755);
    },
  },
  {
    name: "ludusavi",
    installedPath: path.join(LUDUSAVI_DIR, "ludusavi"),
    installedSha256:
      "875607ed064a41bc3bd4c1be75f6d1b3724fbf39c2b0b3cac079857c24a723b0",
    // mtkennerly/ludusavi official release.
    assets: {
      "linux-x64": {
        url: `https://github.com/mtkennerly/ludusavi/releases/download/v${LUDUSAVI_VERSION}/ludusavi-v${LUDUSAVI_VERSION}-linux.tar.gz`,
        sha256:
          "f113843929d50a0c26cb2bb09eef83f9b66b0d9a6675331d667cf28e988258c3",
      },
    },
    install: async (assetPath) => {
      fs.mkdirSync(LUDUSAVI_DIR, { recursive: true });
      await exec(
        `tar -xzf ${quote(assetPath)} -C ${quote(LUDUSAVI_DIR)} ludusavi`
      );
      fs.chmodSync(path.join(LUDUSAVI_DIR, "ludusavi"), 0o755);
    },
  },
  {
    name: "7zzs",
    installedPath: path.join(BINARIES_DIR, "7zzs"),
    installedSha256:
      "20df89e993594c1bb7686f125dabe1acc56c109fb1d9b40435ea5fcbc1ca3453",
    // Official 7-Zip static console binary, linked from 7-zip.org (ip7z/7zip).
    assets: {
      "linux-x64": {
        url: `https://github.com/ip7z/7zip/releases/download/${SEVEN_ZIP_VERSION}/7z${SEVEN_ZIP_VERSION.replace(".", "")}-linux-x64.tar.xz`,
        sha256:
          "41aaba7b1235304ab5aa0624530c67ae829496cd29e875925271efdccc28c03e",
      },
    },
    install: async (assetPath) => {
      fs.mkdirSync(BINARIES_DIR, { recursive: true });
      await exec(`tar -xJf ${quote(assetPath)} -C ${quote(BINARIES_DIR)} 7zzs`);
      fs.chmodSync(path.join(BINARIES_DIR, "7zzs"), 0o755);
    },
  },
];

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const sha256OfFile = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const fileMatchesHash = async (filePath, expectedSha256) => {
  if (!fs.existsSync(filePath)) return false;
  return (await sha256OfFile(filePath)) === expectedSha256;
};

const downloadAndVerify = async (url, expectedSha256) => {
  const tmpPath = path.join(
    os.tmpdir(),
    `hydra-download-${crypto.randomBytes(8).toString("hex")}`
  );

  console.log(`Downloading ${url} ...`);
  const response = await axios.get(url, { responseType: "stream" });

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    response.data.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    response.data.pipe(out);
  });

  const actualSha256 = await sha256OfFile(tmpPath);
  if (actualSha256 !== expectedSha256) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(
      `Checksum verification failed for ${url}\n` +
        `  expected: ${expectedSha256}\n` +
        `  actual:   ${actualSha256}`
    );
  }

  console.log(`Verified sha256 for ${path.basename(url)}`);
  return tmpPath;
};

const ensureComponent = async (component) => {
  if (
    await fileMatchesHash(component.installedPath, component.installedSha256)
  ) {
    console.log(`${component.name} already present and verified, skipping.`);
    return;
  }

  const asset = component.assets[PLATFORM_KEY];
  if (!asset) {
    throw new Error(
      `No pinned ${component.name} asset for ${PLATFORM_KEY}; ` +
        `this fork builds linux-x64 only.`
    );
  }

  const assetPath = await downloadAndVerify(asset.url, asset.sha256);
  try {
    await component.install(assetPath);
  } finally {
    fs.rmSync(assetPath, { force: true });
  }

  if (
    !(await fileMatchesHash(component.installedPath, component.installedSha256))
  ) {
    throw new Error(
      `${component.name} was installed but its checksum did not match the pin.`
    );
  }

  console.log(`${component.name} installed and verified.`);
};

const main = async () => {
  for (const component of components) {
    await ensureComponent(component);
  }
};

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
