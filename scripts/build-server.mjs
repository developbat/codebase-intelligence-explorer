import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await fs.rm(path.join(root, "dist-server"), { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, "server/src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: path.join(root, "dist-server/index.mjs"),
  banner: {
    js: 'import { createRequire as __cieCreateRequire } from "node:module"; const require = __cieCreateRequire(import.meta.url);',
  },
  external: ["playwright-core", "typescript", "typescript-language-server", "fsevents"],
  logLevel: "warning",
});
console.log("Server bundled to dist-server/index.mjs");
