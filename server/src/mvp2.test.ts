import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "./analyzer";
import { buildChangeReport } from "./changes";
import { getFileDiff, getGitStatus } from "./git";
import { saveAnalysis } from "./store";

async function write(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

test("MVP 2 adapters detect routes, Prisma models, SQL access, and events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-mvp2-"));
  try {
    await write(
      root,
      "package.json",
      JSON.stringify({
        name: "adapter-demo",
        dependencies: { express: "4", "@nestjs/core": "10", "@prisma/client": "5" },
      }),
    );
    await write(
      root,
      "prisma/schema.prisma",
      [
        "model User {",
        "  id String @id",
        "  orders Order[]",
        "}",
        "",
        "model Order {",
        "  id String @id",
        "  userId String",
        "  user User @relation(fields: [userId], references: [id])",
        "}",
      ].join("\n"),
    );
    await write(
      root,
      "src/user.controller.ts",
      [
        "function Controller(path: string) { return (target: any) => target; }",
        "function Get(path?: string) { return (target: any, key?: string, descriptor?: any) => undefined; }",
        "",
        "@Controller('users')",
        "export class UserController {",
        "  @Get(':id')",
        "  getUser(id: string) { return id; }",
        "}",
      ].join("\n"),
    );
    await write(
      root,
      "src/routes.ts",
      [
        'import { UserController } from "./user.controller";',
        "interface AppLike { get(path: string, handler: any): void; }",
        "export function register(app: AppLike, controller: UserController) {",
        '  app.get("/users/:id", controller.getUser);',
        "}",
      ].join("\n"),
    );
    await write(
      root,
      "src/db.ts",
      [
        "declare const prisma: any;",
        "export async function listOrders() {",
        "  return prisma.order.findMany();",
        "}",
      ].join("\n"),
    );
    await write(
      root,
      "src/events.ts",
      [
        "class Bus { emit(name: string, payload: unknown) {} on(name: string, handler: () => void) {} }",
        "const eventBus = new Bus();",
        "export function publishOrder() { eventBus.emit('order.created', { id: '1' }); }",
        "export function subscribeOrder() { eventBus.on('order.created', () => undefined); }",
      ].join("\n"),
    );

    const result = await analyzeProject(root);
    const routes = result.nodes.filter((node) => node.kind === "route");
    assert.ok(routes.some((route) => route.label === "GET /users/:id"), "NestJS route not found");
    assert.ok(routes.some((route) => route.label === "GET /users/:id" && route.metadata?.framework === "NestJS"));
    assert.ok(result.stats.databases >= 2);
    assert.ok(result.nodes.some((node) => node.kind === "database" && node.label.toLowerCase() === "order"));
    assert.ok(result.nodes.some((node) => node.kind === "event" && node.label === "order.created"));
    assert.ok(result.stats.events >= 1);
    assert.ok(result.frameworks?.includes("NestJS"));
    assert.ok(result.frameworks?.includes("Prisma"));

    const dbNode = result.nodes.find((node) => node.kind === "database" && node.label.toLowerCase() === "order");
    assert.ok(dbNode);
    assert.ok(
      result.edges.some(
        (edge) => edge.kind === "READS_FROM" && edge.target === dbNode.id,
      ),
      "Prisma query did not produce a READS_FROM edge",
    );
    assert.ok(
      result.edges.some((edge) => edge.kind === "PUBLISHES"),
      "event publish edge missing",
    );
    assert.ok(
      result.edges.some((edge) => edge.kind === "SUBSCRIBES_TO"),
      "event subscribe edge missing",
    );
    assert.ok(
      result.edges.some((edge) => edge.kind === "RELATES_TO"),
      "Prisma relation edge missing",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Git status, diff, and structural change report work on a real repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-git-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-data-"));
  const previousDataDir = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    await write(root, "package.json", JSON.stringify({ name: "git-change-demo", private: true }));
    await write(
      root,
      "src/math.ts",
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    await write(
      root,
      "src/index.ts",
      'import { add } from "./math";\nexport function run(): number { return add(1, 2); }\n',
    );

    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });

    const initial = await analyzeProject(root);
    assert.equal(initial.git?.available, true);
    assert.ok(initial.git?.head);
    await saveAnalysis(initial);

    const statusClean = await getGitStatus(root, initial);
    assert.equal(statusClean.available, true);
    assert.equal(statusClean.files.length, 0);

    await write(
      root,
      "src/math.ts",
      "export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n",
    );
    await write(root, "src/new.ts", "export const value = 42;\n");

    const status = await getGitStatus(root, initial);
    assert.ok(status.files.some((file) => file.path === "src/math.ts" && file.status === "modified"));
    assert.ok(status.files.some((file) => file.path === "src/new.ts" && file.status === "untracked"));
    assert.ok(status.files.every((file) => file.sinceAnalysis));

    const diff = await getFileDiff(root, "src/math.ts", initial.git?.head ?? "HEAD");
    assert.ok(diff.diff.includes("+  return a + b + 1;"));
    assert.ok(diff.diff.includes("+export function subtract"));

    const { report, analysis: next } = await buildChangeReport(initial.id);
    assert.equal(report.summary.changedFiles, 2);
    assert.equal(report.summary.addedFiles, 1);
    assert.ok(report.summary.changedSymbols >= 2);
    const mathChange = report.structural.find((change) => change.path === "src/math.ts");
    assert.ok(mathChange);
    assert.ok(mathChange.addedSymbols.includes("subtract"));
    assert.ok(mathChange.changedSymbols.includes("add"));
    assert.ok(report.impact.nodes.length >= 2);
    assert.ok(next.stats.symbols > initial.stats.symbols);
  } finally {
    if (previousDataDir === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
