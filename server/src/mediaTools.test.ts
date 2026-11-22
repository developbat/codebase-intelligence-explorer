import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compressVideo } from "./mediaTools";

const run = promisify(execFile);

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

test("video compression writes a smaller mp4 and reports dimensions", async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip("ffmpeg is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-video-"));
  try {
    await fs.mkdir(path.join(root, "assets"), { recursive: true });
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=30:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path.join(root, "assets", "demo.mp4"),
    ]);
    const result = await compressVideo(root, {
      path: "assets/demo.mp4",
      maxWidth: 160,
      crf: 34,
      preset: "ultrafast",
    });
    assert.equal(result.output.path, "assets/demo-compressed.mp4");
    assert.ok(result.output.bytes > 0);
    assert.ok(result.output.width && result.output.width <= 160);
    assert.ok(result.output.durationSeconds && result.output.durationSeconds > 0);
    assert.match(result.command, /ffmpeg/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
