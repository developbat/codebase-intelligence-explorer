import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserCheckStep } from "../../../shared/browserCheck";
import type { ProjectTask } from "../../../shared/tasks";

export interface TaskScenarioMatch {
  name: string;
  path: string;
  url?: string;
  steps: BrowserCheckStep[];
  timeoutMs?: number;
  score: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "please",
  "task", "file", "files", "page", "real", "using", "use", "run", "make", "then",
  "only", "one", "two", "both", "after", "before", "must", "should", "will",
  "bir", "bu", "şu", "ile", "için", "olan", "ve", "veya", "gibi", "daha", "çok",
  "puan", "hedef", "işlem", "oyun", "sayfa", "gerçek", "kullan",
]);

const SYNONYMS: Record<string, string[]> = {
  score: ["puan", "score", "points"],
  target: ["hedef", "target"],
  operator: ["işlem", "operator", "op"],
  multiply: ["çarpma", "çarpı", "multiply", "multiplication", "×", "*"],
  add: ["toplama", "ekle", "add", "plus", "+"],
  subtract: ["çıkarma", "çıkar", "subtract", "minus", "−", "-"],
  wrong: ["yanlış", "wrong", "invalid"],
  correct: ["doğru", "correct", "right"],
};

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function tokens(text: string): string[] {
  const raw = (text.toLowerCase().match(/[a-z0-9çğıöşü_]+/gi) ?? [])
    .filter((token) => (token.length >= 3 || /^\d{2,}$/.test(token)) && !STOPWORDS.has(token))
    .map(stem);
  return [...new Set(raw)];
}

function expand(token: string): string[] {
  const values = new Set([token]);
  for (const [key, aliases] of Object.entries(SYNONYMS)) {
    if (key === token || aliases.includes(token)) {
      values.add(key);
      for (const alias of aliases) values.add(alias);
    }
  }
  return [...values];
}

function scenarioSteps(raw: unknown): BrowserCheckStep[] {
  if (!raw || typeof raw !== "object") return [];
  const steps = (raw as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter(
    (step): step is BrowserCheckStep =>
      Boolean(step) && typeof step === "object" && typeof (step as { action?: unknown }).action === "string",
  );
}

function hasAssertion(steps: BrowserCheckStep[]): boolean {
  return steps.some(
    (step) =>
      [
        "expectText",
        "expectValue",
        "expectCount",
        "expectStable",
        "waitForText",
      ].includes(step.action) ||
      // A JS/pixel assertion can carry its expectation on an eval step.
      (step.action === "eval" &&
        Boolean(step.expectText ?? step.contains ?? step.expected)),
  );
}

/**
 * A task may mention an unrelated scenario only to say it must keep passing.
 * An explicit `run_test_scenario <name>` instruction is authoritative.
 */
function explicitScenarioNames(text: string): string[] {
  const names = new Set<string>();
  const pattern = /run_test_scenario\s+["'`]?([a-z0-9][a-z0-9_-]*)/gi;
  for (const match of text.matchAll(pattern)) {
    names.add(match[1].toLowerCase());
  }
  return [...names];
}

function hasInteraction(steps: BrowserCheckStep[]): boolean {
  return steps.some((step) =>
    ["click", "fill", "press", "pressKeys", "eval"].includes(step.action),
  );
}

/**
 * Find a saved browser scenario that verifies this task. The loop can run it
 * without asking the model to choose or write a browser script.
 */
export async function findTaskScenario(
  rootPath: string,
  task: ProjectTask,
): Promise<TaskScenarioMatch | null> {
  const directory = path.join(rootPath, ".cie", "agent", "scenarios");
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const taskText = `${task.title}\n${task.detail}\n${task.acceptance ?? ""}`.toLowerCase();
  const explicitNames = explicitScenarioNames(taskText);
  const taskTokens = tokens(taskText);
  const matches: TaskScenarioMatch[] = [];

  for (const file of entries.slice(0, 40)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as { path?: unknown; url?: unknown; timeoutMs?: unknown };
    const steps = scenarioSteps(parsed);
    if (steps.length === 0 || !hasAssertion(steps) || !hasInteraction(steps)) continue;

    const name = file.replace(/\.json$/i, "");
    if (explicitNames.length > 0 && !explicitNames.includes(name.toLowerCase())) {
      continue;
    }
    const nameTokens = tokens(name);
    const jsonText = JSON.stringify(parsed).toLowerCase();
    let score = 0;
    for (const token of taskTokens) {
      const values = expand(token);
      if (nameTokens.some((nameToken) => values.includes(nameToken))) score += 3;
      if (values.some((value) => jsonText.includes(value))) score += 1;
    }
    if (taskText.includes(name.toLowerCase())) score += 5;
    if (/presskeys|keys/.test(taskText) && /"presskeys"/i.test(jsonText)) score += 2;
    if (steps.some((step) => step.action === "pressKeys")) score += 1;
    if (score < 4) continue;
    matches.push({
      name,
      path: typeof record.path === "string" ? record.path : "index.html",
      url: typeof (record as { url?: unknown }).url === "string" ? (record as { url: string }).url : undefined,
      steps,
      timeoutMs:
        typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
      score,
    });
  }

  matches.sort((left, right) => right.score - left.score);
  return matches[0] ?? null;
}

/** A task that only needs to prove an existing behavior, not change it. */
export function isScenarioVerificationTask(task: ProjectTask): boolean {
  if (task.verificationOnly === true || task.action === "verify") return true;
  if (
    task.action &&
    ["create", "update", "remove", "move", "document"].includes(task.action)
  ) {
    return false;
  }
  const title = task.title.trim();
  const verifies =
    /^(?:verify|prove|confirm|check|validate|test|run\b[^\n]{0,80}\bscenario|scenario|doğrula|kontrol|kanıtla|senaryo)/i.test(
      title,
    );
  if (!verifies) return false;
  const writes =
    /\b(?:edit|fix|update|change|implement|create|add|remove|delete|replace|write|refactor|ensure|make|unlock|define|route|set)\b|ekle|düzelt|güncelle|değiştir|kaldır|sil|yaz/i.test(
      title,
    );
  return !writes;
}
