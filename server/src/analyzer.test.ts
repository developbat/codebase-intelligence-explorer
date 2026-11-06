import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject, projectIdForPath } from "./analyzer";

test("fixture projesi fonksiyon seviyesinde çağrı grafiği üretir", async () => {
  const root = path.resolve("fixtures/sample-app");
  const result = await analyzeProject(root);

  assert.equal(result.projectName, "acme-orders");
  assert.equal(result.stats.files, 10);
  assert.ok(result.stats.symbols >= 35, `beklenen >=35 sembol, gelen ${result.stats.symbols}`);
  assert.ok(result.stats.functions >= 25);
  assert.equal(result.stats.unresolvedEdges, 0);
  assert.equal(result.stats.truncated, false);

  const byQualifiedName = new Map(
    result.nodes.map((node) => [node.metadata?.qualifiedName ?? node.label, node]),
  );

  const calls = result.edges.filter((edge) => edge.kind === "CALLS");
  const hasCall = (source: string, target: string) =>
    calls.some((edge) => edge.source === byQualifiedName.get(source)?.id && edge.target === byQualifiedName.get(target)?.id);

  assert.ok(hasCall("OrderService.createOrder", "UserRepository.findById"));
  assert.ok(hasCall("OrderService.createOrder", "OrderService.validateItems"));
  assert.ok(hasCall("OrderService.createOrder", "OrderService.calculateTotal"));
  assert.ok(hasCall("OrderService.createOrder", "PaymentService.charge"));
  assert.ok(hasCall("OrderService.createOrder", "EmailService.sendOrderConfirmation"));
  assert.ok(hasCall("OrderController.create", "OrderService.createOrder"));

  const imports = result.edges.filter((edge) => edge.kind === "IMPORTS");
  const controllerFile = result.files.find((file) => file.path.endsWith("order.controller.ts"));
  const serviceFile = result.files.find((file) => file.path.endsWith("order.service.ts"));
  assert.ok(controllerFile && serviceFile);
  assert.ok(
    imports.some(
      (edge) => edge.source === `file:${controllerFile.path}` && edge.target === `file:${serviceFile.path}`,
    ),
  );

  for (const edge of result.edges) {
    if (edge.kind === "CALLS" || edge.kind === "IMPORTS") {
      assert.ok(edge.evidence && edge.evidence.length > 0, `${edge.kind} edge kanıtsız: ${edge.id}`);
      assert.ok(edge.certainty !== "unresolved", "fixture içinde çözülemeyen çağrı olmamalı");
    }
  }

  assert.equal(projectIdForPath(root), result.id);
});

test("CommonJS require() kenarı kaynak kanıtıyla çıkarılır", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-cjs-"));
  try {
    await fs.writeFile(path.join(root, "math.cjs"), "exports.add = (a, b) => a + b;\n");
    await fs.writeFile(
      path.join(root, "index.cjs"),
      'const { add } = require("./math.cjs");\nfunction run() { return add(1, 2); }\nmodule.exports = { run };\n',
    );
    await fs.writeFile(path.join(root, ".env"), "SECRET=value\n");
    await fs.writeFile(path.join(root, "private.pem"), "PRIVATE KEY\n");

    const result = await analyzeProject(root);
    const index = result.files.find((file) => file.path === "index.cjs");
    const math = result.files.find((file) => file.path === "math.cjs");
    assert.ok(index && math);
    assert.equal(result.files.length, 2);

    const requireEdge = result.edges.find(
      (edge) => edge.source === `file:${index.path}` && edge.target === `file:${math.path}`,
    );
    assert.ok(requireEdge, "require() import kenarı bulunamadı");
    assert.equal(requireEdge.certainty, "inferred");
    assert.ok(requireEdge.evidence?.some((item) => item.description?.includes("require()")));

    assert.ok(result.symbols.some((symbol) => symbol.qualifiedName === "add"));
    const add = result.symbols.find((symbol) => symbol.qualifiedName === "add")!;
    const run = result.symbols.find((symbol) => symbol.qualifiedName === "run")!;
    assert.ok(
      result.edges.some(
        (edge) => edge.kind === "CALLS" && edge.source === run.id && edge.target === add.id,
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("analiz node_modules ve secret dosyalarını okumaz", async () => {
  const root = path.resolve("fixtures/sample-app");
  const result = await analyzeProject(root);

  for (const file of result.files) {
    assert.ok(!file.path.includes("node_modules"));
    assert.ok(!file.path.endsWith(".env"));
    assert.ok(!file.path.endsWith(".pem"));
    assert.ok(!file.path.endsWith(".key"));
  }

  assert.ok(result.rootPath.startsWith("/"));
  assert.ok(result.stats.sourceBytes > 0);
  assert.ok(result.stats.durationMs >= 0);
});
