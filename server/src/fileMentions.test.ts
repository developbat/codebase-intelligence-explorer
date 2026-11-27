import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractFileMentions,
  formatFileMentions,
  readFileMentions,
} from "./ai/fileMentions";

test("extracts @file mentions and ignores emails and secrets", () => {
  assert.deepEqual(
    extractFileMentions("Compare @src/app.ts with @README.md, mail foo@bar.com, skip @.env"),
    ["src/app.ts", "README.md"],
  );
});

test("reads mentioned files and formats a prompt block", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-mentions-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "app.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(root, "README.md"), "# Demo\n");
    const mentions = await readFileMentions(root, "Read @src/app.ts and @README.md");
    assert.deepEqual(
      mentions.map((mention) => mention.path),
      ["src/app.ts", "README.md"],
    );
    assert.match(formatFileMentions(mentions), /Explicitly referenced files/);
    assert.match(formatFileMentions(mentions), /export const value = 1;/);
    assert.deepEqual(await readFileMentions(root, "Read @../outside.ts"), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
