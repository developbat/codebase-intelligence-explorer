import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlaceholderAsset } from "./placeholderAssets";

test("creates deterministic SVG placeholders and rejects escapes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-assets-"));
  try {
    const icon = await createPlaceholderAsset(root, {
      path: "assets/icon",
      kind: "icon",
      label: "App",
      width: 256,
    });
    assert.equal(icon.path, "assets/icon.svg");
    assert.equal(icon.mime, "image/svg+xml");
    const svg = await fs.readFile(path.join(root, icon.path), "utf8");
    assert.match(svg, /<svg/);
    assert.match(svg, />AP</);

    const sprite = await createPlaceholderAsset(root, {
      path: "assets/player.svg",
      kind: "sprite",
      label: "player",
    });
    assert.match(await fs.readFile(path.join(root, sprite.path), "utf8"), /sprite|circle|path/);

    await assert.rejects(
      () => createPlaceholderAsset(root, { path: "../escape.svg", kind: "icon" }),
      /outside the project/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
