const fs = require("node:fs");
const path = require("node:path");

function clean(directory) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (
      entry.name.startsWith("._") ||
      entry.name === ".DS_Store" ||
      entry.name === "__MACOSX"
    ) {
      fs.rmSync(absolute, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) clean(absolute);
  }
}

module.exports = async function afterPack(context) {
  clean(context.appOutDir);
};
