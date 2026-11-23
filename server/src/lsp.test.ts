import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  lspDiagnostics,
  lspHover,
  lspServerFor,
  lspServersStatus,
  shutdownLspSessions,
  supportsLsp,
} from "./lsp";

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

test("file extensions map to the right language server", () => {
  assert.equal(lspServerFor("src/app.ts")?.id, "typescript");
  assert.equal(lspServerFor("src/app.py")?.id, "pyright");
  assert.equal(lspServerFor("src/main.go")?.id, "gopls");
  assert.equal(lspServerFor("src/lib.rs")?.id, "rust-analyzer");
  assert.equal(lspServerFor("src/index.php")?.id, "intelephense");
  assert.equal(supportsLsp("README.md"), false);
  const ids = lspServersStatus().map((server) => server.id);
  assert.deepEqual(ids, ["typescript", "pyright", "rust-analyzer", "gopls", "intelephense"]);
});
