import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { auditContentInventory } from "./contentInventory";

test("audits assets, broken references and markdown heading hierarchy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-content-inventory-"));
  try {
    await fs.mkdir(path.join(root, "assets"), { recursive: true });
    await fs.writeFile(path.join(root, "assets/used.png"), "used");
    await fs.writeFile(path.join(root, "assets/bg.png"), "bg");
    await fs.writeFile(path.join(root, "assets/unused.png"), "unused");
    await fs.writeFile(
      path.join(root, "index.html"),
      [
        '<link rel="stylesheet" href="styles.css">',
        '<img src="assets/used.png">',
        '<img src="assets/missing.png">',
        '<script src="app.js"></script>',
      ].join("\n"),
    );
    await fs.writeFile(path.join(root, "styles.css"), 'body { background: url("assets/bg.png"); }\n');
    await fs.writeFile(path.join(root, "app.js"), "console.log('ok');\n");
    await fs.writeFile(
      path.join(root, "README.md"),
      "# Title\n\n### Jumped\n\n## Next\n\n# Second H1\n",
    );
    const analysis = {
      id: "contentinventory1",
      rootPath: root,
      createdAt: new Date().toISOString(),
      files: [
        { path: "index.html", bytes: 100, loc: 4 },
        { path: "styles.css", bytes: 40, loc: 1 },
        { path: "app.js", bytes: 20, loc: 1 },
        { path: "README.md", bytes: 40, loc: 5 },
      ],
      symbols: [],
    } as unknown as AnalysisResult;

    const inventory = await auditContentInventory(analysis);
    assert.equal(inventory.summary.assets, 3);
    assert.equal(inventory.summary.unreferenced, 1);
    assert.equal(inventory.unreferenced[0]?.path, "assets/unused.png");
    assert.ok(
      inventory.broken.some(
        (item) => item.file === "index.html" && item.reference === "assets/missing.png",
      ),
    );
    const used = inventory.assets.find((asset) => asset.path === "assets/used.png");
    assert.ok(used?.referencedBy.some((ref) => ref.file === "index.html"));
    const background = inventory.assets.find((asset) => asset.path === "assets/bg.png");
    assert.ok(background?.referencedBy.some((ref) => ref.file === "styles.css"));
    assert.equal(inventory.markdown.length, 1);
    assert.ok(inventory.markdown[0].warnings.some((warning) => /Multiple h1/i.test(warning)));
    assert.ok(inventory.markdown[0].warnings.some((warning) => /jump/i.test(warning)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
