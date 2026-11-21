import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectDevCommands, extractLocalUrls } from "./processes";

test("extractLocalUrls finds and normalizes dev server addresses", () => {
  const output = [
    "  VITE v6.0.0  ready in 312 ms",
    "  ➜  Local:   http://localhost:5173/",
    "  ➜  Network: http://0.0.0.0:4173/",
    "  preview: http://127.0.0.1:3000/app?x=1",
    "  docs: https://example.com/docs",
    "  duplicate: http://localhost:5173",
  ].join("\n");
  assert.deepEqual(extractLocalUrls(output), [
    "http://localhost:5173",
    "http://localhost:4173",
    "http://127.0.0.1:3000/app?x=1",
  ]);
  assert.deepEqual(extractLocalUrls("no urls here"), []);
});

test("detectDevCommands reads package scripts and lockfile manager", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-dev-"));
  try {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "vite --host", start: "node server.js", test: "vitest" } }),
    );
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const commands = await detectDevCommands(root);
    assert.deepEqual(
      commands.map((item) => item.command),
      ["pnpm install", "pnpm dev", "pnpm start"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("detectDevCommands understands generated FastAPI, PHP and static templates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-dev-"));
  try {
    await fs.mkdir(path.join(root, "app"));
    await fs.writeFile(
      path.join(root, "app", "main.py"),
      "from fastapi import FastAPI\n\napp = FastAPI()\n",
    );
    assert.deepEqual(
      (await detectDevCommands(root)).map((item) => item.command),
      ["uvicorn app.main:app --reload"],
    );
    await fs.rm(path.join(root, "app"), { recursive: true, force: true });

    await fs.mkdir(path.join(root, "public"));
    await fs.writeFile(path.join(root, "public", "index.php"), "<?php echo 'ok';\n");
    assert.deepEqual(
      (await detectDevCommands(root)).map((item) => item.command),
      ["php -S localhost:8000 -t public"],
    );
    await fs.rm(path.join(root, "public"), { recursive: true, force: true });

    await fs.writeFile(path.join(root, "index.html"), "<h1>Hello</h1>\n");
    assert.deepEqual(
      (await detectDevCommands(root)).map((item) => item.command),
      ["python3 -m http.server 8000"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("detectDevCommands falls back to Python and Ruby servers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-dev-"));
  try {
    await fs.writeFile(path.join(root, "manage.py"), "print('ok')\n");
    const python = await detectDevCommands(root);
    assert.equal(python[0]?.command, "python3 manage.py runserver");

    const rubyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cie-dev-"));
    try {
      await fs.mkdir(path.join(rubyRoot, "bin"));
      await fs.writeFile(path.join(rubyRoot, "bin", "rails"), "#!/usr/bin/env ruby\n");
      await fs.writeFile(path.join(rubyRoot, "Gemfile"), "source 'https://rubygems.org'\n");
      const ruby = await detectDevCommands(rubyRoot);
      assert.equal(ruby[0]?.command, "bin/rails server");
    } finally {
      await fs.rm(rubyRoot, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
