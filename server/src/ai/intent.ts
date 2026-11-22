import fs from "node:fs/promises";
import path from "node:path";
import { loadAnalysis } from "../store";
import { chat } from "./providers";
import { recordUsage } from "./usage";
import { getPublicSettings, resolveAgentRole, resolveProvider } from "./settings";
import { pickAlternateAgentModel } from "./agents";
import { healthKey, modelHealthByProviderModel } from "./modelStats";
import { estimateUsageCost } from "./pricing";
import type { AnalysisResult } from "../../../shared/types";
import type {
  IntentAnalysis,
  IntentKind,
  IntentMode,
  IntentOption,
  IntentScope,
  IntentVerification,
} from "../../../shared/intent";
import {
  INTENT_KINDS,
  INTENT_MODES,
  INTENT_SCOPES,
  INTENT_VERIFICATIONS,
} from "../../../shared/intent";
import { documentStats, readDocument } from "../documentTools";

const MAX_OUTPUT_TOKENS = 700;
const TIMEOUT_MS = 35_000;

interface IntentOptions {
  provider?: string;
  model?: string;
  language?: string;
  activeFile?: string;
  /** The user already answered a clarification question; do not ask again. */
  clarified?: boolean;
  history?: { role: "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
}

async function htmlAssets(analysis: AnalysisResult, activeFile?: string): Promise<string[]> {
  const candidates = [activeFile, "index.html", "public/index.html"].filter(
    (item): item is string => Boolean(item),
  );
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(path.join(analysis.rootPath, candidate), "utf8");
      const assets = [...content.matchAll(/(?:src|href)=["']([^"']+)["']/gi)]
        .map((match) => match[1].trim())
        .filter((value) => value && !/^(https?:|data:|#|mailto:|javascript:)/i.test(value))
        .map((value) => value.replace(/^\.\//, "").replace(/^\//, ""))
        .filter((value) => !value.startsWith(".."));
      return [...new Set(assets)].slice(0, 12);
    } catch {
      // try the next entry point
    }
  }
  return [];
}

async function projectFacts(analysis: AnalysisResult, activeFile?: string): Promise<string> {
  const languages = Object.entries(analysis.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}(${count})`)
    .join(", ");
  const files = analysis.files
    .slice(0, 40)
    .map((file) => file.path)
    .join(", ");
  const tooling = analysis.tooling;
  const assets = await htmlAssets(analysis, activeFile);
  return [
    `Project: ${analysis.projectName}`,
    `Root: ${analysis.rootPath}`,
    `Languages: ${languages || "unknown"}`,
    `Frameworks: ${(analysis.frameworks ?? []).join(", ") || "none detected"}`,
    `Files: ${analysis.stats.files} · folders: ${analysis.stats.folders}`,
    `Active file: ${activeFile ?? "none"}`,
    `Test commands: ${tooling?.testCommands.join(" | ") || "none"}`,
    `Typecheck commands: ${tooling?.typecheckCommands?.join(" | ") || "none"}`,
    `Build commands: ${tooling?.buildCommands.join(" | ") || "none"}`,
    assets.length > 0 ? `HTML references (loaded assets): ${assets.join(", ")}` : "",
    `Files (sample): ${files || "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function systemPrompt(): string {
  return `You are the intent analyst for a coding agent. Read the user request in any language (typos are possible) and the project facts. Return JSON only. Never write code.

Schema:
{"kind":"edit|question|run|scaffold|analyze","understanding":"one sentence in the user's language","language":"tr|en|zh|...","needsClarification":true|false,"question":"question in the user's language","options":[{"label":"short option in the user's language","suffix":"text appended to the user's original instruction when this option is chosen"}],"scope":"trivial|small|medium|large","mode":"single|loop","areas":["exact project-relative file paths"],"verification":"none|browser|test|build","approach":"one-sentence strategy using tools and how to verify completeness","needsExhaustiveEvidence":true|false,"assumptions":["short assumptions"]}

Rules:
- Restate the user's goal accurately in "understanding". Paraphrase it, do not copy it. Describe what the user wants, not an investigation plan. Do not invent features or fields.
- Write "understanding", "question", "options[].label" and "options[].suffix" in the interface language, unless the request is clearly in a different language; in that case use the request language.
- Ask only when a wrong guess would implement the wrong feature or the requested object/field is genuinely ambiguous. Max 4 options. Options must be product/behavior choices, not implementation steps.
- Never ask which files to read or where the code lives; the executor inspects automatically and "areas" is your best guess.
- If the request names a product concept (detail, priority, reminder, status, tag), clarify its product behavior. Example: "task detail" -> ask "How should task detail work?" with options "multiline detail input shown under the task", "separate detail panel", "both". Never ask "which files should I inspect?".
- If the request is already clear, set needsClarification=false, question="", options=[].
- "kind": use "run" only when the user explicitly asks to execute a command, test, build or server. Checking, counting, searching, reading and summarizing are "analyze", not "run".
- "scope": trivial = one property/line; small = one component or file; medium = a few files/behaviors; large = architecture, many modules, or a new app.
- "mode": "single" for one focused change; "loop" only when the work has multiple independent parts that need separate verification.
- "areas": likely existing files from the sample; put new files only when the request clearly creates them. Do not invent unrelated files.
- Prefer the smallest area that can satisfy the request. A CSS-only change must point at the stylesheet, not every file.
- "verification": browser for UI/static pages, test when tests exist and behavior is testable, build when compilation is the main risk, none when nothing meaningful applies.
- "approach": choose the most efficient evidence strategy for this request. For complete lists/counts/audits, propose searching for the relevant markers and collecting all matches with count/offset; do not rely on a partial read.
- "needsExhaustiveEvidence": true when the user asks for a complete list, count, audit or "all" items; otherwise false.
- Never make the user choose a model or restate the whole request.
- If the user already answered a clarification, needsClarification must be false.

Good clarification example:
User: "add a task detail field"
{"needsClarification":true,"question":"How should task detail work?","options":[{"label":"Multiline detail input","suffix":"Add an optional multiline detail field and show it under the task."},{"label":"Separate detail panel","suffix":"Add a detail field and open a detail panel when the task is clicked."},{"label":"Both","suffix":"Add a detail field, show it in the list, and open a detail panel."}]}

Bad clarification example (do not do this):
"Which files should I inspect?" or "Where is the task form?"`;
}

async function attachmentFacts(analysis: AnalysisResult, instruction: string): Promise<string> {
  const paths = [...instruction.matchAll(/(?:Ek dosya|Attached file|Ekli dosya):\s*([^\s]+)/gi)]
    .map((match) => match[1])
    .slice(0, 3);
  if (paths.length === 0) return "";
  const lines: string[] = [];
  for (const pathValue of paths) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const document = await readDocument(analysis.rootPath, pathValue, {
        maxChars: 12_000,
        ocr: false,
      });
      const stats = document.stats ?? documentStats(document.text);
      lines.push(
        `- ${document.path}: ${stats.lines} lines, ${stats.checkedBoxes} checked, ${stats.uncheckedBoxes} unchecked checkboxes`,
      );
    } catch {
      lines.push(`- ${pathValue}: unreadable`);
    }
  }
  return `Attached documents:\n${lines.join("\n")}`;
}

async function userPrompt(
  analysis: AnalysisResult,
  instruction: string,
  options: IntentOptions,
): Promise<string> {
  return [
    await projectFacts(analysis, options.activeFile),
    `Interface language (use for understanding, question and option labels): ${options.language ?? "unknown"}`,
    options.clarified ? "The user already clarified the request. Do not ask again." : "",
    options.history && options.history.length > 0
      ? `Recent conversation (use it to resolve references like "again", "the same", "that file"):\n${options.history
          .slice(-8)
          .map((message) => `${message.role}: ${message.content.slice(0, 1_200)}`)
          .join("\n")}`
      : "",
    await attachmentFacts(analysis, instruction),
    `User request:\n${instruction.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function cleanJson(text: string): string {
  const trimmed = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Intent analyst did not return JSON.");
  return trimmed.slice(start, end + 1);
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function safeArea(value: string): string | null {
  const raw = value.trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw) || raw.includes("..")) return null;
  const area = raw.replace(/^\.\//, "");
  if (!area || area.startsWith(".git/")) return null;
  return area;
}

export function parseIntentResponse(
  raw: string,
  analysis: AnalysisResult,
  instruction: string,
  clarified = false,
): IntentAnalysis {
  const parsed = JSON.parse(cleanJson(raw)) as Record<string, unknown>;
  const kind = pickEnum(parsed.kind, INTENT_KINDS, "edit") as IntentKind;
  const scope = pickEnum(parsed.scope, INTENT_SCOPES, "small") as IntentScope;
  const mode = pickEnum(parsed.mode, INTENT_MODES, scope === "large" || scope === "medium" ? "loop" : "single") as IntentMode;
  const verification = pickEnum(parsed.verification, INTENT_VERIFICATIONS, "none") as IntentVerification;
  const approach =
    typeof parsed.approach === "string" && parsed.approach.trim()
      ? parsed.approach.trim().slice(0, 800)
      : "";
  const needsExhaustiveEvidence = parsed.needsExhaustiveEvidence === true;
  const understanding =
    typeof parsed.understanding === "string" && parsed.understanding.trim()
      ? parsed.understanding.trim().slice(0, 500)
      : instruction.trim().slice(0, 500);
  const language =
    typeof parsed.language === "string" && parsed.language.trim()
      ? parsed.language.trim().slice(0, 20)
      : "unknown";

  const knownFiles = new Set(analysis.files.map((file) => file.path));
  const areas = Array.isArray(parsed.areas)
    ? [
        ...new Set(
          parsed.areas
            .filter((item): item is string => typeof item === "string")
            .map(safeArea)
            .filter((item): item is string => Boolean(item))
            .filter((item) => knownFiles.has(item))
            .slice(0, 8),
        ),
      ]
    : [];

  const options: IntentOption[] = Array.isArray(parsed.options)
    ? parsed.options
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item, index) => ({
          id: `opt-${index + 1}`,
          label:
            typeof item.label === "string" && item.label.trim()
              ? item.label.trim().slice(0, 120)
              : `Option ${index + 1}`,
          instructionSuffix:
            typeof item.suffix === "string" && item.suffix.trim()
              ? item.suffix.trim().slice(0, 400)
              : "",
        }))
        .filter((item) => item.instructionSuffix)
        .slice(0, 4)
    : [];

  const needsClarification =
    !clarified &&
    kind !== "question" &&
    parsed.needsClarification === true &&
    typeof parsed.question === "string" &&
    parsed.question.trim().length > 0 &&
    options.length > 0;

  const assumptions = Array.isArray(parsed.assumptions)
    ? parsed.assumptions
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 240))
        .slice(0, 5)
    : [];

  return {
    kind,
    understanding,
    language,
    needsClarification,
    question: needsClarification ? String(parsed.question).trim().slice(0, 300) : undefined,
    options: needsClarification ? options : undefined,
    scope,
    mode,
    areas,
    verification,
    approach,
    needsExhaustiveEvidence,
    assumptions,
  };
}

async function resolveIntentModel(options: IntentOptions) {
  const settings = await getPublicSettings().catch(() => null);
  const fastRole = settings?.agentRoles.find((role) => role.role === "fast");
  let config = await resolveProvider(
    (fastRole?.provider as IntentOptions["provider"]) ?? options.provider,
    fastRole?.model ?? options.model,
  ).catch(() => resolveAgentRole("main", { provider: options.provider, model: options.model }));
  const health = await modelHealthByProviderModel().catch(() => new Map());
  if (health.get(healthKey(config.id, config.model))?.unavailable === true) {
    const alternate = await pickAlternateAgentModel({
      provider: config.id,
      model: config.model,
    }).catch(() => null);
    if (alternate) {
      config = await resolveProvider(
        alternate.provider as IntentOptions["provider"],
        alternate.model,
      ).catch(() => config);
    }
  }
  return config;
}

/**
 * One small model call that decides what the user actually asked for, how large
 * the change is, which files are likely involved, and whether a question is
 * needed. It deliberately carries only compact project facts.
 */
export async function analyzeIntent(
  projectId: string,
  instruction: string,
  options: IntentOptions = {},
): Promise<{
  intent: IntentAnalysis;
  provider: string;
  model: string;
  totalTokens: number;
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  costUsd?: number;
}> {
  const analysis = await loadAnalysis(projectId);
  if (!instruction.trim()) throw new Error("An instruction is required.");
  const config = await resolveIntentModel(options);
  const messages = [
    { role: "system" as const, content: systemPrompt() },
    { role: "user" as const, content: await userPrompt(analysis, instruction, options) },
  ];
  let tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const ask = async (retry = false): Promise<string> =>
    chat(
      config,
      retry
        ? [
            ...messages,
            {
              role: "user" as const,
              content:
                "Your previous reply was not valid JSON. Reply with the JSON object only, no Markdown or prose.",
            },
          ]
        : messages,
      {
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        timeoutMs: TIMEOUT_MS,
        signal: options.signal,
        onUsage: (usage) => {
          tokenUsage = usage;
        },
      },
    );

  let raw: string;
  try {
    raw = await ask();
  } catch (error) {
    throw new Error(
      `Intent analysis failed with ${config.id}/${config.model}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  let intent: IntentAnalysis;
  try {
    intent = parseIntentResponse(raw, analysis, instruction, options.clarified);
  } catch {
    try {
      raw = await ask(true);
      intent = parseIntentResponse(raw, analysis, instruction, options.clarified);
    } catch {
      intent = {
        kind: "edit",
        understanding: instruction.trim().slice(0, 500),
        language: options.language ?? "unknown",
        needsClarification: false,
        scope: "small",
        mode: "single",
        areas: [],
        verification: "none",
        approach: "",
        needsExhaustiveEvidence: false,
        assumptions: ["Intent analyst could not parse its reply; proceeding with one focused task."],
      };
    }
  }

  if (tokenUsage.totalTokens === 0) {
    const inputTokens = Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4);
    const outputTokens = Math.ceil(raw.length / 4);
    tokenUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }
  await recordUsage({
    projectId,
    provider: config.id,
    model: config.model,
    kind: "intent",
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    totalTokens: tokenUsage.totalTokens,
  }).catch(() => undefined);

  const costUsd = await estimateUsageCost(config.id, config.model, tokenUsage).catch(() => undefined);
  return {
    intent,
    provider: config.id,
    model: config.model,
    totalTokens: tokenUsage.totalTokens,
    tokenUsage,
    costUsd,
  };
}
