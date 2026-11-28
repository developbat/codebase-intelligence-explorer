import assert from "node:assert/strict";
import test from "node:test";
import type { TaskBrief } from "./ai/taskBrief";
import {
  briefPromptFacts,
  renderTaskBriefMarkdown,
  taskBriefKey,
} from "./ai/taskBrief";
import { analyzeRequestFrame } from "./ai/requestFrame";
import type { AnalysisResult } from "../../shared/types";

const analysis = {
  id: "audit",
  projectName: "audit",
  rootPath: "/tmp/audit",
  files: [{ path: "README.md" }],
  languages: {},
  tooling: {},
} as unknown as AnalysisResult;

const brief: TaskBrief = {
  key: "chess-cat-theme-tr",
  language: "tr",
  instruction: "Kedili bir satranç oyunu yap",
  domain: { id: "chess", name: "Chess", summary: "Board game" },
  summary: "Kedili temalı satranç oyunu.",
  invariants: ["Rok kurallara uygun olmalı"],
  norms: ["Legal move ipuçları gösterilmeli (https://example.com/chess-ui)"],
  components: ["Board", "Move validator"],
  dataModel: ["board[8][8]"],
  ux: ["Son hamle vurgulanmalı"],
  pitfalls: ["Şahı tehdit altında bırakan hamle"],
  acceptance: ["Rok yalnızca kurallara uygunken yapılabilir"],
  openDecisions: ["Oyuncu kime karşı oynasın?"],
  extras: ["cat theme"],
  sources: [{ title: "Chess UI guide", url: "https://example.com/chess-ui" }],
  verifiedAt: "2026-11-28T13:00:00.000Z",
  cached: false,
};

test("task brief key includes domain, extras and language", () => {
  const frame = analyzeRequestFrame(
    "Kedili bir satranç oyunu yap",
    analysis,
    "tr",
  );
  assert.equal(taskBriefKey(frame, "tr"), "chess-cat-theme-tr");
});

test("renders a Turkish brief with sources and extras", () => {
  const markdown = renderTaskBriefMarkdown(brief);
  assert.match(markdown, /Görev brief'i/);
  assert.match(markdown, /Değişmez kurallar/);
  assert.match(markdown, /Araştırılan normlar/);
  assert.match(markdown, /Kullanıcı ekstraları/);
  assert.match(markdown, /chess-ui/);
});

test("prompt facts carry norms, acceptance, extras and sources", () => {
  const facts = briefPromptFacts(brief);
  assert.match(facts, /Researched norms/);
  assert.match(facts, /Acceptance checks/);
  assert.match(facts, /cat theme/);
  assert.match(facts, /https:\/\/example.com\/chess-ui/);
});
