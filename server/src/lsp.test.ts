import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { lspDiagnostics, lspHover, shutdownLspSessions } from "./lsp";

test(
  "LSP reports TypeScript diagnostics and hover information",
  { timeout: 20_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-lsp-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(
        path.join(root, "src", "app.ts"),
        'const value: number = "not a number";\nfunction greet(name: string) {\n  return `Hello ${name}`;\n}\ngreet(42);\n',
        "utf8",
      );
      const diagnostics = await lspDiagnostics(root, "src/app.ts");
      assert.equal(diagnostics.supported, true);
      assert.ok(diagnostics.diagnostics.some((item) => item.severity === "error"));
      assert.match(diagnostics.diagnostics[0].message, /not assignable|argument/i);
      const hover = await lspHover(root, "src/app.ts", 2, 10);
      assert.match(hover?.contents ?? "", /greet/);
    } finally {
      await shutdownLspSessions();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
