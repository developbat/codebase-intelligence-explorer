import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import type { ProjectTask, ProjectTaskHistoryEntry } from "../../shared/tasks";
import {
  addProjectConstraints,
  buildProjectBrain,
  compactProjectBrainBrief,
  ensureProjectBrain,
  extractProjectConstraints,
  loadProjectBrain,
  projectBrainPaths,
  redactSecrets,
  renderProjectBrainMarkdown,
  updateProjectBrainFromTask,
} from "./projectBrain";

async function fixture(): Promise<{ root: string; analysis: AnalysisResult }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-project-brain-"));
  await fs.writeFile(
    path.join(root, "index.html"),
    '<!doctype html><link rel="icon" href="data:,"><link rel="stylesheet" href="./styles.css"><script src="./game.js"></script>',
  );
  await fs.writeFile(path.join(root, "game.js"), "function drawKey() {}\nfunction startGame() {}\n");
  await fs.writeFile(path.join(root, "styles.css"), ".hud { color: cyan; }\n");
  await fs.writeFile(path.join(root, "app.js"), "// unused legacy file\n");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { dev: "vite", build: "vite build", test: "node --test" } }),
  );
  const analysis = {
    id: "0123456789abcdef",
    projectName: "Neon Maze",
    rootPath: root,
    createdAt: "2026-01-01T00:00:00.000Z",
    warnings: [],
    languages: { JavaScript: 3, HTML: 1, CSS: 1 },
    frameworks: [],
    stats: {
      files: 4,
      folders: 0,
      lines: 10,
      symbols: 2,
      functions: 2,
      classes: 0,
      nodes: 4,
      edges: 1,
      confirmedEdges: 1,
      inferredEdges: 0,
      unresolvedEdges: 0,
      routes: 0,
      databases: 0,
      events: 0,
      sourceBytes: 100,
      durationMs: 1,
      truncated: false,
    },
    tooling: {
      ecosystems: ["Node"],
      packageManagers: ["npm"],
      frameworks: [],
      testCommands: ["npm test"],
      buildCommands: ["npm run build"],
      typecheckCommands: ["npm run typecheck"],
      lintCommands: [],
      formatCommands: [],
      manifests: ["package.json"],
      testFileCount: 0,
      hasTests: true,
    },
    files: [
      { id: "f1", path: "index.html", language: "html", bytes: 10, loc: 1, hash: "a", imports: [] },
      { id: "f2", path: "game.js", language: "javascript", bytes: 10, loc: 2, hash: "b", imports: [] },
      { id: "f3", path: "styles.css", language: "css", bytes: 10, loc: 1, hash: "c", imports: [] },
      { id: "f4", path: "app.js", language: "javascript", bytes: 10, loc: 1, hash: "d", imports: [] },
    ],
    symbols: [
      {
        id: "s1",
        name: "drawKey",
        qualifiedName: "drawKey",
        kind: "function",
        filePath: "game.js",
        startLine: 1,
        endLine: 1,
        signature: "drawKey()",
        parameters: [],
        exported: false,
        async: false,
      },
      {
        id: "s2",
        name: "startGame",
        qualifiedName: "startGame",
        kind: "function",
        filePath: "game.js",
        startLine: 2,
        endLine: 2,
        signature: "startGame()",
        parameters: [],
        exported: false,
        async: false,
      },
    ],
    nodes: [],
    edges: [],
    externalModules: [],
  } as unknown as AnalysisResult;
  return { root, analysis };
}

test("project brain bootstraps identity, entry points and key files", async (t) => {
  const { root, analysis } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const brain = await buildProjectBrain(analysis, { history: [], queue: null });
  assert.equal(brain.identity.kind, "game");
  assert.ok(brain.identity.entryPoints.includes("index.html"));
  assert.ok(brain.identity.entryPoints.includes("game.js"));
  assert.ok(!brain.identity.entryPoints.includes("app.js"));
  assert.ok(!brain.identity.entryPoints.includes("data:,"));
  assert.ok(brain.inventory.files.some((file) => file.path === "game.js" && file.role === "game logic"));
  assert.match(brain.architecture.summary, /Neon Maze/i);
  const brief = compactProjectBrainBrief(brain);
  assert.match(brief, /Project brain/);
  assert.match(brief, /index\.html/);
  assert.match(brief, /game\.js/);
  assert.ok(brief.length <= 4_200);
});

test("project brain persists, reloads and renders markdown", async (t) => {
  const { root, analysis } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const brain = await ensureProjectBrain(analysis, { force: true });
  const paths = projectBrainPaths(root);
  await fs.stat(paths.json);
  await fs.stat(paths.markdown);
  const loaded = await loadProjectBrain(root);
  assert.ok(loaded);
  assert.equal(loaded?.projectId, analysis.id);
  const markdown = renderProjectBrainMarkdown(brain);
  assert.match(markdown, /## Identity/);
  assert.match(markdown, /## Key files/);
});

test("task updates add features and recent changes without leaking secrets", async (t) => {
  const { root, analysis } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await ensureProjectBrain(analysis, { force: true });
  const task = {
    id: "task-1",
    title: "Fix the blue ball respawn",
    detail: "",
    status: "done",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 1,
    changedFiles: ["game.js"],
    commands: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    resultSummary: "Moved the gem to a walkable cell. password: hunter2 apiKey: sk-abcdefghijklmnop",
  } as unknown as ProjectTask;
  const next = await updateProjectBrainFromTask(
    analysis,
    task,
    { summary: task.resultSummary ?? "", changedFiles: ["game.js"] },
    "done",
  );
  assert.ok(next.features.some((feature) => feature.name.includes("blue ball")));
  assert.ok(next.recentChanges.some((change) => change.summary.includes("walkable")));
  assert.ok(!JSON.stringify(next).includes("hunter2"));
  assert.ok(!JSON.stringify(next).includes("sk-abcdefghijklmnop"));
});

test("history seeds features and recent changes for an existing project", async () => {
  const { root, analysis } = await fixture();
  const history: ProjectTaskHistoryEntry[] = [
    {
      goal: "Build the game",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:10:00.000Z",
      tasks: [
        {
          id: "task-old",
          title: "Build the maze and HUD",
          detail: "",
          status: "done",
          effort: "standard",
          role: "main",
          dependsOn: [],
          attempts: 1,
          changedFiles: ["game.js", "index.html"],
          commands: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:10:00.000Z",
          resultSummary: "Built the maze, HUD and key.",
        } as ProjectTask,
      ],
    },
  ];
  const brain = await buildProjectBrain(analysis, { history, queue: null });
  await fs.rm(root, { recursive: true, force: true });
  assert.ok(brain.features.some((feature) => feature.name.includes("maze")));
  assert.ok(brain.recentChanges.some((change) => change.summary.includes("maze")));
});

test("redaction removes common secret formats", () => {
  const text = "password: hunter2 token=abc123 apiKey: sk-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz";
  const clean = redactSecrets(text);
  assert.ok(!clean.includes("hunter2"));
  assert.ok(!clean.includes("abc123"));
  assert.ok(!clean.includes("sk-abcdefghijklmnop"));
  assert.ok(!clean.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
});

test("server-only and no-secret constraints are persisted in the brain", async (t) => {
  const { root, analysis } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const constraints = extractProjectConstraints(
    "Sadece sunucu tarafında düzelt, uygulama koduna dokunma. Parola yanıtta görünmesin.",
  );
  assert.ok(constraints.some((text) => /server-side/i.test(text)));
  assert.ok(constraints.some((text) => /application/i.test(text)));
  assert.ok(constraints.some((text) => /password|credential/i.test(text)));
  const brain = await addProjectConstraints(analysis, constraints, "test");
  assert.ok(brain.constraints.length >= 3);
  assert.ok(brain.constraints.some((constraint) => constraint.kind === "security"));
});

test("task evidence is marked claimed or verified and ids include createdAt", async (t) => {
  const { root, analysis } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await ensureProjectBrain(analysis, { force: true });
  const task = {
    id: "task-1",
    title: "Break walls",
    detail: "",
    status: "done",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 1,
    changedFiles: ["game.js"],
    commands: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  } as unknown as ProjectTask;
  const next = await updateProjectBrainFromTask(
    analysis,
    task,
    {
      summary: "Walls break with an energy cost and the map cell becomes walkable.",
      changedFiles: ["game.js"],
    },
    "done",
    "verified",
  );
  const feature = next.features.find((item) => item.name === "Break walls");
  assert.ok(feature);
  assert.equal(feature?.evidence, "verified");
  assert.match(feature?.id ?? "", /^task:task-1:2026-01-01/);
  const change = next.recentChanges.find((item) => item.summary.includes("Walls break"));
  assert.equal(change?.evidence, "verified");
  const brief = compactProjectBrainBrief(next);
  assert.match(brief, /unverified claims/i);
  assert.match(brief, /\[verified\]/);
});

test("failed no-change summaries are not promoted to known issues", async (t) => {
  const { root, analysis } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await ensureProjectBrain(analysis, { force: true });
  const task = {
    id: "task-2",
    title: "Check the fallback",
    detail: "",
    status: "failed",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 2,
    changedFiles: [],
    commands: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:01:00.000Z",
  } as unknown as ProjectTask;
  const noChange = await updateProjectBrainFromTask(
    analysis,
    task,
    {
      summary: "No file was changed; respawnReward already meets the acceptance criteria.",
      changedFiles: [],
    },
    "failed",
    "claimed",
  );
  assert.ok(
    !noChange.knownIssues.some((issue) => /No file was changed/i.test(issue.text)),
    "no-change summary must not become a known issue",
  );

  const realError = await updateProjectBrainFromTask(
    analysis,
    { ...task, id: "task-3" },
    {
      summary: "TypeError: Cannot read properties of undefined while drawing the HUD.",
      changedFiles: ["game.js"],
    },
    "failed",
    "claimed",
  );
  assert.ok(
    realError.knownIssues.some((issue) => /TypeError/.test(issue.text)),
    "a real runtime error should stay a known issue",
  );
});
