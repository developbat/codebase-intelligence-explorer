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

    const sheet = await createPlaceholderAsset(root, {
      path: "assets/sheet",
      kind: "spritesheet",
      width: 512,
      height: 512,
    });
    assert.equal(sheet.path, "assets/sheet.svg");
    assert.match(await fs.readFile(path.join(root, sheet.path), "utf8"), /<g transform=/);
    assert.equal(sheet.metadataPath, "assets/sheet.json");
    const metadata = JSON.parse(await fs.readFile(path.join(root, "assets/sheet.json"), "utf8")) as {
      frameWidth: number;
      columns: number;
    };
    assert.equal(metadata.columns, 4);
    assert.equal(metadata.frameWidth, 128);

    const sound = await createPlaceholderAsset(root, {
      path: "assets/beep.wav",
      kind: "sound",
      durationMs: 200,
      frequency: 440,
    });
    assert.equal(sound.mime, "audio/wav");
    const wav = await fs.readFile(path.join(root, sound.path));
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.subarray(8, 12).toString(), "WAVE");

    const music = await createPlaceholderAsset(root, {
      path: "assets/loop",
      kind: "music",
      durationMs: 1200,
      frequency: 220,
      loop: true,
    });
    assert.equal(music.path, "assets/loop.wav");
    assert.equal((await fs.readFile(path.join(root, music.path))).subarray(0, 4).toString(), "RIFF");

    await assert.rejects(
      () => createPlaceholderAsset(root, { path: "../escape.svg", kind: "icon" }),
      /outside the project/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
