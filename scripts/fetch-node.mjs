import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fetch the pinned Node LTS runtime used by project commands and app-managed
 * tools. The binaries are not committed; packaging runs this script first.
 *
 * Usage:
 *   node scripts/fetch-node.mjs
 *   node scripts/fetch-node.mjs --platform=win32 --arch=x64
 *   node scripts/fetch-node.mjs --force
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = path.join(root, "vendor", "node-version.json");
const { version } = JSON.parse(await fsp.readFile(versionFile, "utf8"));

const args = process.argv.slice(2);
function option(name, fallback) {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const platform = option("platform", process.platform);
const arch = option("arch", process.arch === "arm64" ? "arm64" : "x64");
const force = args.includes("--force");
const archivePlatform = platform === "win32" ? "win" : platform;
const archiveName = `node-v${version}-${archivePlatform}-${arch}.${
  platform === "win32" ? "zip" : "tar.gz"
}`;
const targetDir = path.join(root, "vendor", "node", "current");
const cacheDir = path.join(root, "vendor", "node", "cache", `${platform}-${arch}-v${version}`);
const downloadsDir = path.join(root, "vendor", "node", "downloads");
const marker = path.join(targetDir, ".cie-node-version");
const expectedMarker = `${version} ${platform}-${arch}`;

if (!force) {
  try {
    const current = (await fsp.readFile(marker, "utf8")).trim();
    if (current === expectedMarker) {
      console.log(`Node v${version} (${platform}-${arch}) already prepared.`);
      process.exit(0);
    }
  } catch {
    // Fetch it.
  }
}

await fsp.mkdir(downloadsDir, { recursive: true });
const archivePath = path.join(downloadsDir, archiveName);
const baseUrl = `https://nodejs.org/dist/v${version}`;

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(destination, buffer);
  return buffer;
}

async function expectedSha() {
  const response = await fetch(`${baseUrl}/SHASUMS256.txt`);
  if (!response.ok) throw new Error(`Could not read SHASUMS256.txt: HTTP ${response.status}`);
  const text = await response.text();
  const line = text
    .split(/\r?\n/)
    .find((entry) => entry.trim().endsWith(`  ${archiveName}`) || entry.trim().endsWith(` *${archiveName}`));
  if (!line) throw new Error(`No checksum found for ${archiveName}.`);
  return line.trim().split(/\s+/)[0];
}

let archive = null;
try {
  archive = await fsp.readFile(archivePath);
} catch {
  // Download below.
}
const sha = await expectedSha();
if (!archive || createHash("sha256").update(archive).digest("hex") !== sha) {
  process.stdout.write(`Downloading Node v${version} (${platform}-${arch})...\n`);
  archive = await download(`${baseUrl}/${archiveName}`, archivePath);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== sha) {
    await fsp.rm(archivePath, { force: true });
    throw new Error(`Checksum mismatch for ${archiveName}: expected ${sha}, got ${actual}`);
  }
}

const tempDir = path.join(root, "vendor", "node", `.extract-${process.pid}-${Date.now()}`);
await fsp.rm(tempDir, { recursive: true, force: true });
await fsp.mkdir(tempDir, { recursive: true });
try {
  // bsdtar (macOS, Windows 10+) and GNU tar both auto-detect tar.gz and zip.
  // Do not use PowerShell Expand-Archive: the runner's PowerShell 7 module
  // fails with "Cannot find an overload for ExtractToDirectory".
  execFileSync("tar", ["-xf", archivePath, "-C", tempDir], { stdio: "inherit" });
  const entries = await fsp.readdir(tempDir, { withFileTypes: true });
  const extracted = entries.find((entry) => entry.isDirectory());
  if (!extracted) throw new Error(`Unexpected Node archive layout for ${archiveName}.`);
  const source = path.join(tempDir, extracted.name);
  await fsp.rm(cacheDir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(cacheDir), { recursive: true });
  await fsp.cp(source, cacheDir, { recursive: true, dereference: false, verbatimSymlinks: true });
  // Headers, man pages, docs and corepack are not needed at runtime. Keeping
  // them inflates the installer and the signing pass.
  const prune = [
    "include",
    "share",
    "CHANGELOG.md",
    "README.md",
    "bin/corepack",
    "lib/node_modules/corepack",
    "node_modules/corepack",
    "lib/node_modules/npm/docs",
    "node_modules/npm/docs",
    "lib/node_modules/npm/man",
    "node_modules/npm/man",
    "lib/node_modules/npm/html",
    "node_modules/npm/html",
  ];
  for (const relative of prune) {
    await fsp.rm(path.join(cacheDir, relative), { recursive: true, force: true });
  }
} finally {
  await fsp.rm(tempDir, { recursive: true, force: true });
}

await fsp.rm(targetDir, { recursive: true, force: true });
await fsp.mkdir(path.dirname(targetDir), { recursive: true });
await fsp.cp(cacheDir, targetDir, { recursive: true, dereference: false, verbatimSymlinks: true });
await fsp.rm(cacheDir, { recursive: true, force: true });
await fsp.writeFile(marker, `${expectedMarker}\n`, "utf8");

const binary = platform === "win32" ? path.join(targetDir, "node.exe") : path.join(targetDir, "bin", "node");
if (!fs.existsSync(binary)) {
  throw new Error(`Node binary missing after extraction: ${binary}`);
}
console.log(`Node v${version} (${platform}-${arch}) ready at vendor/node/current.`);
