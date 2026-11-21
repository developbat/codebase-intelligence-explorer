import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDiskFiles } from "./ai/service";

test("listDiskFiles reflects moves and ignores generated folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-filelist-"));
  try {
    await fs.mkdir(path.join(root, "css"), { recursive: true });
    await fs.mkdir(path.join(root, "js"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "index.html"), "<h1>ok</h1>");
    await fs.writeFile(path.join(root, "css", "styles.css"), "body{}");
    await fs.writeFile(path.join(root, "js", "app.js"), "console.log(1)");
    await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "ignored");
    await fs.writeFile(path.join(root, "._index.html"), "ignored metadata");

    const all = await listDiskFiles(root, "", 50);
    assert.deepEqual(all.map((file) => file.path), ["css/styles.css", "index.html", "js/app.js"]);

    const css = await listDiskFiles(root, "css", 50);
    assert.deepEqual(css.map((file) => file.path), ["css/styles.css"]);

    const file = await listDiskFiles(root, "index.html", 50);
    assert.deepEqual(file.map((item) => item.path), ["index.html"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
