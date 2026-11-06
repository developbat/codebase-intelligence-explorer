import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export type SourceLanguage = "typescript" | "tsx" | "javascript" | "jsx";

export interface ScannedFile {
  absPath: string;
  relPath: string;
  language: SourceLanguage;
  content: string;
  bytes: number;
  loc: number;
  hash: string;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/** Folders that never carry first-party source code. */
const IGNORED_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.hg/**",
  "**/.svn/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/output/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/.parcel-cache/**",
  "**/target/**",
  "**/bin/**",
  "**/obj/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/Pods/**",
  "**/DerivedData/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/generated/**",
  "**/__generated__/**",
  "**/*.min.js",
  "**/*.bundle.js",
  "**/*.map",
  "**/*.d.ts",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.crt",
  "**/*.cer",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/secrets.*",
  "**/credentials.*",
];

const MAX_FILES = 1200;
const MAX_FILE_BYTES = 1_500_000;

export interface ScanOptions {
  maxFiles?: number;
  signal?: AbortSignal;
}

export interface ScanResult {
  rootPath: string;
  projectName: string;
  files: ScannedFile[];
  packageJson: PackageManifest | null;
  tsconfigPath: string | null;
  warnings: string[];
  totalCandidates: number;
  sourceBytes: number;
}

export interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function toLanguage(filePath: string): SourceLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!SOURCE_EXTENSIONS.includes(ext)) return null;
  switch (ext) {
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return "typescript";
  }
}

function sha1(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Scans a project folder in read-only mode.
 * Files are only ever opened with fs.readFile; nothing is written or executed.
 */
export async function scanProject(inputPath: string, options: ScanOptions = {}): Promise<ScanResult> {
  const requested = path.resolve(inputPath);
  let rootPath: string;
  try {
    rootPath = await fs.realpath(requested);
  } catch {
    throw new Error(`Folder not found: ${inputPath}`);
  }

  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory()) {
    throw new Error("The selected path is not a folder.");
  }

  const maxFiles = options.maxFiles ?? MAX_FILES;
  const warnings: string[] = [];

  const entries = await fg("**/*", {
    cwd: rootPath,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: IGNORED_GLOBS,
    suppressErrors: true,
  });

  const candidates: { relPath: string; language: SourceLanguage; size: number }[] = [];
  let skippedLarge = 0;
  let skippedUnsupported = 0;

  for (const relPath of entries) {
    const language = toLanguage(relPath);
    if (!language) {
      skippedUnsupported += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const fileStat = await fs.stat(path.join(rootPath, relPath));
    if (fileStat.size > MAX_FILE_BYTES) {
      skippedLarge += 1;
      continue;
    }
    candidates.push({ relPath, language, size: fileStat.size });
  }

  candidates.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const selected = candidates.slice(0, maxFiles);
  if (candidates.length > maxFiles) {
    warnings.push(
      `${candidates.length} source files found; only the first ${maxFiles} were analyzed. Choose a smaller folder or raise the file limit.`,
    );
  }
  if (skippedLarge > 0) warnings.push(`${skippedLarge} files were skipped because they exceed the 1.5 MB limit.`);
  if (skippedUnsupported > 0) {
    warnings.push(`${skippedUnsupported} unsupported (non-TS/JS) files were skipped.`);
  }

  const files: ScannedFile[] = [];
  let sourceBytes = 0;
  let readErrors = 0;

  for (const candidate of selected) {
    if (options.signal?.aborted) throw new Error("Analiz iptal edildi.");
    const absPath = path.join(rootPath, candidate.relPath);
    try {
      // Read-only access. The file handle is immediately released.
      const content = await fs.readFile(absPath, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      sourceBytes += bytes;
      files.push({
        absPath,
        relPath: candidate.relPath.split(path.sep).join("/"),
        language: candidate.language,
        content,
        bytes,
        loc: content.length === 0 ? 0 : content.split("\n").length,
        hash: sha1(content),
      });
    } catch {
      readErrors += 1;
    }
  }
  if (readErrors > 0) warnings.push(`${readErrors} files could not be read.`);

  const packageJson = await readJson<PackageManifest>(path.join(rootPath, "package.json"));
  const tsconfigCandidates = ["tsconfig.json", "jsconfig.json"];
  let tsconfigPath: string | null = null;
  for (const name of tsconfigCandidates) {
    try {
      await fs.access(path.join(rootPath, name));
      tsconfigPath = path.join(rootPath, name);
      break;
    } catch {
      // keep looking
    }
  }

  return {
    rootPath,
    projectName: packageJson?.name?.trim() || path.basename(rootPath),
    files,
    packageJson,
    tsconfigPath,
    warnings,
    totalCandidates: candidates.length,
    sourceBytes,
  };
}
