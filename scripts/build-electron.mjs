import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-electron");

await fs.rm(outDir, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, "electron/main.cjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: path.join(outDir, "main.cjs"),
  external: ["electron"],
  logLevel: "warning",
});
await fs.copyFile(path.join(root, "electron/preload.cjs"), path.join(outDir, "preload.cjs"));
console.log("Electron main bundled to dist-electron/main.cjs");
