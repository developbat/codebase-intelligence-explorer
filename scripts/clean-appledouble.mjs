import fs from "node:fs";
import path from "node:path";

const targets = [
  "node_modules/playwright-core",
  "node_modules/fsevents",
  "node_modules/typescript",
  "dist",
  "dist-server",
  "dist-electron",
  "build",
];

function clean(directory) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.name.startsWith("._") || entry.name === ".DS_Store") {
      fs.rmSync(absolute, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) clean(absolute);
  }
}

for (const target of targets) clean(path.resolve(target));
console.log("Cleaned AppleDouble files from packaged resource sources.");
