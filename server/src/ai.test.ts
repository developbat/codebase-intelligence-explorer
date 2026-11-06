import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeSymbol,
  askProject,
  discoverBusinessFlows,
  summarizeProject,
  summarizeScope,
} from "./ai/service";
import { updateAiSettings } from "./ai/settings";
import { analyzeProject } from "./analyzer";
import { saveAnalysis } from "./store";

test("AI service sends real source and parses structured results through an OpenAI-compatible provider", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-ai-data-"));
  const previousDataDir = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;

  const received: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "mock-coder" }] }));
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/chat/completions")) {
        const payload = JSON.parse(body) as { messages?: { content?: string }[] };
        const prompt = (payload.messages ?? []).map((message) => message.content ?? "").join("\n");
        received.push(prompt);
        let content: string;
        if (prompt.includes("purpose") && prompt.includes("businessSteps")) {
          content = JSON.stringify({
            purpose: "Creates an order from the provided items.",
            businessSteps: ["Loads the user", "Creates the order"],
            inputs: ["userId", "items"],
            outputs: ["Order"],
            sideEffects: ["database_write"],
            risks: ["Payment may fail after the order is persisted."],
            uncertainties: ["Payment provider behavior is not fully visible."],
            evidence: [{ file: "src/services/order.service.ts", start_line: 15, end_line: 41 }],
          });
        } else if (prompt.includes("summarizing a file, folder, or package")) {
          content = JSON.stringify({
            summary: "The order service owns order creation and cancellation.",
            responsibilities: ["Validate items", "Create orders", "Charge payments"],
            dependencies: ["OrderRepository", "PaymentService"],
            risks: ["Payment and email are direct side effects."],
            evidence: [{ file: "src/services/order.service.ts", start_line: 15, end_line: 41 }],
          });
        } else if (prompt.includes("business-flow analyst")) {
          content = JSON.stringify({
            flows: [
              {
                name: "Create order",
                description: "A user submits items and receives a paid order.",
                confidence: "high",
                steps: [
                  { label: "Controller receives request", file: "src/controllers/order.controller.ts", startLine: 8, endLine: 14, kind: "function" },
                  { label: "OrderService creates order", file: "src/services/order.service.ts", startLine: 15, endLine: 41, kind: "function" },
                ],
                entities: ["Order", "Payment"],
                risks: ["Payment failure after persistence."],
              },
            ],
          });
        } else if (prompt.includes("software architect")) {
          content = JSON.stringify({
            summary: "A demo order application.",
            architecture: "Controller → service → repository, with payment and email adapters.",
            keyFlows: ["Create order", "Cancel order"],
            entryPoints: ["src/index.ts"],
            risks: ["In-memory demo persistence."],
            evidence: [{ file: "src/index.ts", start_line: 1, end_line: 10 }],
          });
        } else {
          content = "The order flow starts in OrderService.createOrder, which calls PaymentService.charge.";
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await updateAiSettings({
      provider: "custom",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "mock-coder",
      defaultProvider: "custom",
      defaultModel: "mock-coder",
    });

    const analysis = await analyzeProject(path.resolve("fixtures/sample-app"));
    await saveAnalysis(analysis);
    const symbol = analysis.symbols.find((item) => item.qualifiedName === "OrderService.createOrder");
    assert.ok(symbol);

    const result = await analyzeSymbol(analysis.id, symbol.id);
    assert.equal(result.provider, "custom");
    assert.equal(result.model, "mock-coder");
    assert.ok(result.purpose.length > 0);
    assert.ok(result.businessSteps.length >= 2);
    assert.ok(result.sideEffects.includes("database_write"));
    assert.ok(result.evidence.length > 0);
    assert.ok(received.some((prompt) => prompt.includes("return this.orderRepository.updateStatus")));
    assert.ok(received.some((prompt) => prompt.includes("Write every human-readable string value in English")));

    const cached = await analyzeSymbol(analysis.id, symbol.id);
    assert.equal(cached.cached, true);

    const localized = await analyzeSymbol(analysis.id, symbol.id, { language: "tr", force: true });
    assert.equal(localized.cached, false);
    assert.ok(received.some((prompt) => prompt.includes("Write every human-readable string value in Turkish")));

    const chat = await askProject(analysis.id, "How does order creation work?");
    assert.ok(chat.answer.includes("OrderService.createOrder"));
    assert.ok(chat.evidence.length > 0);

    const fileNode = analysis.nodes.find((node) => node.kind === "file" && node.filePath?.endsWith("order.service.ts"));
    assert.ok(fileNode);
    const scope = await summarizeScope(analysis.id, fileNode.id);
    assert.equal(scope.kind, "file");
    assert.ok(scope.responsibilities.length > 0);
    assert.ok(scope.dependencies.includes("PaymentService"));

    const flows = await discoverBusinessFlows(analysis.id);
    assert.ok(flows.flows.length > 0);
    assert.ok(flows.flows[0].steps.length >= 2);
    assert.ok(flows.flows[0].name.length > 0);

    const project = await summarizeProject(analysis.id);
    assert.ok(project.summary.length > 0);
    assert.ok(project.keyFlows.length > 0);
    assert.ok(project.entryPoints.length > 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
