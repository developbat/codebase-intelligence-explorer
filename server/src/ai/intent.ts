import fs from "node:fs/promises";
import path from "node:path";
import { listRecent, loadAnalysis } from "../store";
import {
  analysisHasUi,
  projectSummaryHasUi,
  requestIsCurrentProjectScope,
  requestIsRunPreview,
  requestMentionsUi,
} from "../../../shared/projectMatch";
import { chat } from "./providers";
import { recordUsage } from "./usage";
import { getPublicSettings, resolveAgentRole, resolveProvider } from "./settings";
import { listSkills, readSkillFeedback, skillFeedbackScore, skillMentionSlug } from "../skills";
import { pickAlternateAgentModel } from "./agents";
import { healthKey, modelHealthByProviderModel } from "./modelStats";
import { estimateUsageCost } from "./pricing";
import type { AnalysisResult, RecentProject } from "../../../shared/types";
import type {
  AgentToolGroup,
  IntentAmbiguity,
  IntentAnalysis,
  IntentBehavior,
  IntentContext,
  IntentHistory,
  IntentKind,
  IntentMode,
  IntentOption,
  IntentScope,
  IntentVerification,
} from "../../../shared/intent";
import {
  AGENT_TOOL_GROUPS,
  INTENT_CONTEXTS,
  INTENT_HISTORIES,
  INTENT_KINDS,
  INTENT_MODES,
  INTENT_SCOPES,
  INTENT_VERIFICATIONS,
} from "../../../shared/intent";
import { documentStats, readDocument } from "../documentTools";
import {
  applyDomainClarification,
  domainPromptFacts,
  matchDomainCards,
} from "./domainKnowledge";
import {
  analyzeRequestFrame,
  isEffectivelyEmptyProject,
  requestFrameFacts,
  requestMentionsExtra,
  type RequestFrame,
} from "./requestFrame";

const MAX_OUTPUT_TOKENS = 1_600;
const TIMEOUT_MS = 35_000;

interface IntentOptions {
  provider?: string;
  model?: string;
  language?: string;
  activeFile?: string;
  /** The user already answered a clarification question; do not ask again. */
  clarified?: boolean;
  /** Compact enabled-skill index shown to the intent analyst. */
  skillIndex?: string;
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
    .slice(0, 16)
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
{"kind":"edit|question|run|scaffold|analyze","understanding":"one sentence in the user's language","language":"tr|en|zh|...","needsClarification":true|false,"question":"question in the user's language","options":[{"label":"short option in the user's language","suffix":"text appended to the user's original instruction when this option is chosen"}],"normalizedRequest":"canonical English restatement","behaviors":[{"id":"b1","action":"create|update|remove|move|verify|run|document|other","surface":"ui|api|data|config|docs|game|other","target":"what changes","details":"exact requested details","acceptance":"observable check"}],"constraints":["explicit user constraint"],"ambiguities":[{"id":"a1","question":"one product decision","impact":"high|low","options":[{"label":"option","suffix":"text appended to the original request"}]}],"confidence":0.0,"scope":"trivial|small|medium|large","mode":"single|loop","areas":["exact project-relative file paths"],"verification":"none|browser|test|build","context":"none|focused|project","history":"none|recent|extended","toolGroups":["core","edit","command","document","web","git","browser","skills","media","mobile","notes","tools"],"skills":["skill-slug"],"approach":"one-sentence strategy using tools and how to verify completeness","needsExhaustiveEvidence":true|false,"assumptions":["short assumptions"]}

Rules:
- Restate the user's goal accurately in "understanding" in the user's language. In "normalizedRequest", write the same meaning as one canonical English sentence for downstream planning; keep identifiers and quoted values unchanged.
- Decompose the request into "behaviors": one entry per independent change. Each behavior needs action, surface, target, details and a concrete acceptance check. Do not merge two independent changes into one behavior; do not invent behaviors the user did not ask for.
- Put explicit user rules ("do not change X", "only Y", "preserve Z") into "constraints" exactly as rules, not as tasks.
- Put only high-impact product decisions into "ambiguities" (a wrong guess would implement the wrong product behavior). Each ambiguity gets 2-3 concrete options. Never ask which files to inspect; that is not a product decision.
- "confidence" is 0-1 for this interpretation. Use a lower value when the request is short, ambiguous, or missing acceptance details.
- If a high-impact ambiguity exists, set needsClarification=true and use that question/options; otherwise needsClarification=false.
- Write "understanding", "question", "options[].label" and "options[].suffix" in the interface language, unless the request is clearly in a different language; in that case use the request language.
- Ask only when a wrong guess would implement the wrong feature or the requested object/field is genuinely ambiguous. Max 4 options. Options must be product/behavior choices, not implementation steps.
- Never ask which files to read or where the code lives; the executor inspects automatically and "areas" is your best guess.
- If the request names a product concept (detail, priority, reminder, status, tag), clarify its product behavior. Example: "task detail" -> ask "How should task detail work?" with options "multiline detail input shown under the task", "separate detail panel", "both". Never ask "which files should I inspect?".
- Check the project map before asking how to build something. If the requested behavior/symbols already exist, note that in "understanding"/"assumptions" and ask only what should change if needed; do not ask a from-scratch implementation question.
- If the request is already clear, set needsClarification=false, question="", options=[].
- "kind": use "run" only when the user explicitly asks to execute a command, test, build or server. Checking, counting, searching, reading and summarizing are "analyze", not "run".
- For a greeting, thanks, or general chat that needs no project work ("hi", "naber", "thanks", "what is a closure?"), use kind="question", context="none", history="none", toolGroups=[], scope="trivial", areas=[], verification="none". Do not turn it into an edit.
- "scope": trivial = one property/line; small = one component or file; medium = a few files/behaviors; large = architecture, many modules, or a new app.
- "mode": "single" for one focused change; "loop" only when the work has multiple independent parts that need separate verification.
- "areas": likely existing files from the sample; put new files only when the request clearly creates them. Do not invent unrelated files.
- Prefer the smallest area that can satisfy the request. A CSS-only change must point at the stylesheet, not every file.
- "verification": browser for UI/static pages, test when tests exist and behavior is testable, build when compilation is the main risk, none when nothing meaningful applies.
- "context": none only for greetings, thanks, or general knowledge that does not depend on this project; focused when the request targets specific files, a small edit or a document; project for broader project questions or changes. If unsure, use project.
- "history": none for a standalone request; recent when the request refers to the last turns ("again", "same", "on it", "bunu", "tekrar"); extended when it refers to older discussion. If unsure, use recent.
- "toolGroups": choose the minimum tool families the executor needs. Core read/search tools are always available, so omit "core". Use edit for writing, command for running/verifying, document for attachments/PDF/Office/CSV/images, web for HTTP/web research, git for Git operations, browser for browser verification, skills for saved tools/skills, media for graphics/video, mobile for simulators, notes for saved research, tools for toolchain installation. If a capability is genuinely needed, include its group; when unsure, include it rather than omitting a required tool. For a greeting or general chat return [].
- "skills": choose 0-3 slugs from the Available skills list only when the task clearly matches. Prefer an empty array over a weak match. Never invent a slug.
- "approach": choose the most efficient evidence strategy for this request. For complete lists/counts/audits, propose searching for the relevant markers and collecting all matches with count/offset; do not rely on a partial read.
- "needsExhaustiveEvidence": true when the user asks for a complete list, count, audit or "all" items; otherwise false.
- If the project already has an implementation for the requested feature (the existing-symbol hints show it), do not ask how that feature should work. Extend the existing behavior; ask only about a genuinely new product choice.
- Preserve prohibitions exactly: "do not re-add", "don't change X", "remove nothing", "mevcut itemleri yeniden ekleme" are constraints. Never turn a prohibition into a positive action.
- Never make the user choose a model or restate the whole request.
- If the user already answered a clarification, needsClarification must be false.
- If a "Domain reference" is present, treat its rules as authoritative over your own memory, use its vocabulary, and prefer its high-impact questions when the request is a new build and leaves that decision open. Never ask what the request already answers.
- If the "Request frame" says action=build or newBuild=true, use kind="scaffold". A new build belongs to the active project even when that project is empty; never ask which project it belongs to.
- Treat userExtras (theme, colors, mascots, style) as required behaviors separate from domain rules. Never drop them; do not let a theme change the rules or the meaning of decision options.

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

function intentQueries(instruction: string): Set<string> {
  const stop = new Set([
    "the","and","for","with","add","make","get","set","use","from","this","that","bir","için","ile","daha","çok","ama","ve","olan","gibi","hale","getir","ekle","yap","kontrol","et","düzelt",
  ]);
  const aliases: Record<string, string[]> = {
    shooting: ["shoot", "bullet", "fire", "spawn"],
    shoot: ["shoot", "bullet", "fire"],
    bullet: ["bullet", "shoot", "fire"],
    meteor: ["meteor", "obstacle"],
    terlik: ["slipper"],
    komik: ["comedy", "joke"],
    comedy: ["comedy", "joke"],
    ateş: ["fire", "bullet", "shoot"],
    hız: ["speed", "velocity"],
    item: ["powerup", "item", "collect"],
    items: ["powerup", "item", "collect"],
  };
  const words = (instruction.toLowerCase().match(/[a-z0-9_çğıöşü]{3,}/gi) ?? [])
    .map((word) => word.toLowerCase())
    .filter((word) => !stop.has(word));
  const queries = new Set<string>([...words]);
  for (const word of words) for (const alias of aliases[word] ?? []) queries.add(alias);
  return queries;
}

function existingCodeHints(analysis: AnalysisResult, instruction: string): string {
  const queries = intentQueries(instruction);
  const hits = new Map<string, string>();
  for (const symbol of analysis.symbols) {
    const name = symbol.name.toLowerCase();
    const qualified = symbol.qualifiedName.toLowerCase();
    const file = symbol.filePath.toLowerCase();
    if ([...queries].some((query) => name.includes(query) || qualified.includes(query) || file.includes(query))) {
      const key = `${symbol.filePath}:${symbol.name}`;
      if (!hits.has(key)) hits.set(key, `${symbol.filePath}:${symbol.startLine} ${symbol.kind} ${symbol.name}`);
      if (hits.size >= 8) break;
    }
  }
  if (hits.size === 0) return "";
  return `Existing symbols matching the request (check these before assuming a feature is new):\n${[
    ...hits.values(),
  ].join("\n")}`;
}

function likelyProjectAreas(analysis: AnalysisResult, instruction: string): string[] {
  const queries = intentQueries(instruction);
  const files = new Set<string>();
  for (const symbol of analysis.symbols) {
    const haystack = `${symbol.name} ${symbol.qualifiedName} ${symbol.filePath}`.toLowerCase();
    if ([...queries].some((query) => haystack.includes(query))) files.add(symbol.filePath);
    if (files.size >= 6) break;
  }
  for (const file of analysis.files) {
    if ([...queries].some((query) => file.path.toLowerCase().includes(query))) files.add(file.path);
    if (files.size >= 6) break;
  }
  return [...files].slice(0, 3);
}

async function userPrompt(
  analysis: AnalysisResult,
  instruction: string,
  options: IntentOptions,
  domainFacts?: string,
  frameFacts?: string,
): Promise<string> {
  return [
    await projectFacts(analysis, options.activeFile),
    existingCodeHints(analysis, instruction),
    `Interface language (use for understanding, question and option labels): ${options.language ?? "unknown"}`,
    options.clarified ? "The user already clarified the request. Do not ask again." : "",
    frameFacts
      ? `Request frame (deterministic; treat as authoritative for action, domain, extras and newBuild):\n${frameFacts}`
      : "",
    domainFacts
      ? `Domain reference (authoritative; use its rules instead of memory and ask only what the request leaves open):\n${domainFacts}`
      : "",
    options.history && options.history.length > 0
      ? `Recent conversation (use it to resolve references like "again", "the same", "that file"):\n${options.history
          .slice(-6)
          .map((message) => `${message.role}: ${message.content.slice(0, 1_000)}`)
          .join("\n")}`
      : "",
    await attachmentFacts(analysis, instruction),
    options.skillIndex
      ? `Available skills (reference; choose 0-3 slugs for "skills" only when clearly relevant):\n${options.skillIndex}`
      : "",
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

const BEHAVIOR_ACTIONS = [
  "create",
  "update",
  "remove",
  "move",
  "verify",
  "run",
  "document",
  "other",
] as const;
const BEHAVIOR_SURFACES = ["ui", "api", "data", "config", "docs", "game", "other"] as const;

function fallbackIntentSpec(
  instruction: string,
  kind: IntentKind,
): Pick<
  IntentAnalysis,
  "normalizedRequest" | "behaviors" | "constraints" | "ambiguities" | "confidence"
> {
  const text = instruction.replace(/\s+/g, " ").trim();
  const target = text.split(/[.!?\n]/)[0]?.trim().slice(0, 120) || text.slice(0, 120);
  return {
    normalizedRequest: text.slice(0, 220),
    behaviors: [
      {
        id: "b1",
        action: kind === "run" ? "run" : kind === "question" ? "verify" : "update",
        surface: "other",
        target,
        details: "",
        acceptance: "",
      },
    ],
    constraints: [],
    ambiguities: [],
    confidence: 0.45,
  };
}

export function fallbackIntentFromFrame(frame: RequestFrame, instruction: string): IntentAnalysis {
  const kind: IntentKind =
    frame.action === "build"
      ? "scaffold"
      : frame.action === "edit"
        ? "edit"
        : frame.action === "run"
          ? "run"
          : frame.action === "question"
            ? "question"
            : "analyze";
  const verification: IntentVerification =
    frame.surface === "game" || frame.surface === "ui"
      ? "browser"
      : frame.surface === "api" || frame.surface === "data"
        ? "test"
        : "none";
  const behaviors: IntentBehavior[] = [];
  if (kind === "scaffold" || kind === "edit") {
    behaviors.push({
      id: "b1",
      action: kind === "scaffold" ? "create" : "update",
      surface: frame.surface,
      target: frame.deliverable,
      details: instruction.trim(),
      acceptance:
        frame.surface === "game"
          ? "The game follows the domain rules and is playable in the browser."
          : "The requested behavior is visible and usable in the running app.",
    });
    if (frame.extras.length > 0) {
      behaviors.push({
        id: `b${behaviors.length + 1}`,
        action: "update",
        surface: frame.surface,
        target: `Apply ${frame.extras.join(", ")}`,
        details: `Integrate ${frame.extras.join(", ")} without changing the domain rules.`,
        acceptance: `The UI visibly uses ${frame.extras.join(", ")} and the rules still hold.`,
      });
    }
  } else if (kind === "run") {
    behaviors.push({
      id: "b1",
      action: "run",
      surface: "other",
      target: instruction.trim().slice(0, 120),
      details: instruction.trim(),
      acceptance: "The command runs and its output is reported.",
    });
  } else if (kind === "question") {
    behaviors.push({
      id: "b1",
      action: "verify",
      surface: "other",
      target: instruction.trim().slice(0, 120),
      details: instruction.trim(),
      acceptance: "Answer the question with project evidence where relevant.",
    });
  } else {
    behaviors.push({
      id: "b1",
      action: "other",
      surface: frame.surface,
      target: frame.deliverable,
      details: instruction.trim(),
      acceptance: "Report the requested findings.",
    });
  }
  return {
    kind,
    understanding: instruction.trim().slice(0, 500),
    language: frame.language,
    needsClarification: false,
    scope: frame.newBuild ? "large" : kind === "edit" ? "small" : "small",
    mode: frame.newBuild || behaviors.length > 1 ? "loop" : "single",
    areas: [],
    verification,
    context: "project",
    history: "recent",
    toolGroups:
      kind === "question" || kind === "analyze"
        ? []
        : kind === "run"
          ? ["command"]
          : ["edit", "command", "browser"],
    skills: [],
    normalizedRequest: instruction.trim().slice(0, 220),
    behaviors,
    constraints: frame.constraints,
    ambiguities: [],
    confidence: frame.newBuild && frame.domain ? 0.62 : 0.5,
    approach: frame.domain
      ? `Use ${frame.domain.card.name} invariants as constraints, research current norms, then build one small behavior at a time.`
      : "Break the request into small behaviors and verify each in the running app.",
    needsExhaustiveEvidence: false,
    assumptions: ["Intent model was unavailable; used the deterministic request frame."],
    extras: frame.extras,
  };
}

export function applyRequestFrame(intent: IntentAnalysis, frame: RequestFrame): IntentAnalysis {
  let next = intent;
  const buildRequest = frame.action === "build";
  if (buildRequest && frame.newBuild && (next.kind === "edit" || next.kind === "analyze")) {
    next = {
      ...next,
      kind: "scaffold",
      scope: next.scope === "trivial" ? "medium" : next.scope,
      assumptions: [
        ...next.assumptions.filter((item) => !/request frame marks/i.test(item)),
        "Request frame marks this as a new build; using scaffold.",
      ].slice(0, 8),
    };
  }
  if (buildRequest && next.kind === "question" && !next.needsClarification) {
    next = {
      ...next,
      kind: "scaffold",
      scope: next.scope === "trivial" ? "medium" : next.scope,
      assumptions: [
        ...next.assumptions.filter((item) => !/request frame marks/i.test(item)),
        "Request frame marks this as a build; using scaffold.",
      ].slice(0, 8),
    };
  }

  if (frame.extras.length > 0) {
    const behaviors = [...(next.behaviors ?? [])];
    const haystack = [
      next.understanding,
      next.normalizedRequest ?? "",
      ...behaviors.flatMap((behavior) => [
        behavior.target,
        behavior.details,
        behavior.acceptance,
      ]),
      ...(next.constraints ?? []),
      ...(next.assumptions ?? []),
    ]
      .join(" ")
      .toLowerCase();
    const missing = frame.extras.filter((extra) => !requestMentionsExtra(extra, haystack));
    if (missing.length > 0) {
      behaviors.push({
        id: `b${behaviors.length + 1}`,
        action: "update",
        surface: frame.surface,
        target: `Apply ${missing.join(", ")}`,
        details: `Integrate ${missing.join(", ")} without changing the domain rules.`,
        acceptance: `The UI visibly uses ${missing.join(", ")} and the rules still hold.`,
      });
    }
    next = {
      ...next,
      behaviors,
      extras: [...new Set([...(next.extras ?? []), ...frame.extras])],
    };
  }
  if (frame.constraints.length > 0) {
    next = {
      ...next,
      constraints: [...new Set([...(next.constraints ?? []), ...frame.constraints])],
    };
  }
  if ((next.behaviors?.length ?? 0) > 1 && next.mode === "single") {
    next = { ...next, mode: "loop" };
  }
  return next;
}

function ensureIntentSpec(intent: IntentAnalysis, instruction: string): IntentAnalysis {
  if (intent.behaviors && intent.behaviors.length > 0) {
    return {
      ...intent,
      normalizedRequest: intent.normalizedRequest || intent.understanding || instruction.trim(),
      confidence: intent.confidence ?? 0.6,
    };
  }
  return {
    ...intent,
    ...fallbackIntentSpec(instruction, intent.kind),
  };
}

function parseBehaviors(value: unknown): IntentBehavior[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => ({
      id:
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim().slice(0, 40)
          : `b${index + 1}`,
      action:
        typeof item.action === "string" && (BEHAVIOR_ACTIONS as readonly string[]).includes(item.action)
          ? (item.action as IntentBehavior["action"])
          : "update",
      surface:
        typeof item.surface === "string" && (BEHAVIOR_SURFACES as readonly string[]).includes(item.surface)
          ? (item.surface as IntentBehavior["surface"])
          : "other",
      target:
        typeof item.target === "string" && item.target.trim()
          ? item.target.trim().slice(0, 200)
          : "",
      details:
        typeof item.details === "string" && item.details.trim()
          ? item.details.trim().slice(0, 500)
          : "",
      acceptance:
        typeof item.acceptance === "string" && item.acceptance.trim()
          ? item.acceptance.trim().slice(0, 400)
          : "",
    }))
    .filter((item) => item.target)
    .slice(0, 8);
}

function parseAmbiguities(value: unknown): IntentAmbiguity[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => {
      const options: IntentOption[] = Array.isArray(item.options)
        ? item.options
            .filter(
              (option): option is Record<string, unknown> =>
                Boolean(option) && typeof option === "object",
            )
            .map((option, optionIndex) => ({
              id: `opt-${optionIndex + 1}`,
              label:
                typeof option.label === "string" && option.label.trim()
                  ? option.label.trim().slice(0, 120)
                  : `Option ${optionIndex + 1}`,
              instructionSuffix:
                typeof option.suffix === "string" && option.suffix.trim()
                  ? option.suffix.trim().slice(0, 400)
                  : "",
            }))
            .filter((option) => option.instructionSuffix)
            .slice(0, 4)
        : [];
      return {
        id:
          typeof item.id === "string" && item.id.trim()
            ? item.id.trim().slice(0, 40)
            : `a${index + 1}`,
        question:
          typeof item.question === "string" && item.question.trim()
            ? item.question.trim().slice(0, 300)
            : "",
        impact: (item.impact === "high" ? "high" : "low") as "high" | "low",
        options,
      };
    })
    .filter((item) => item.question && item.options.length >= 2)
    .slice(0, 2);
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
  const context = pickEnum(parsed.context, INTENT_CONTEXTS, "project") as IntentContext;
  const history = pickEnum(parsed.history, INTENT_HISTORIES, "recent") as IntentHistory;
  const toolGroups = Array.isArray(parsed.toolGroups)
    ? [
        ...new Set(
          parsed.toolGroups
            .filter((item): item is string => typeof item === "string")
            .filter((item): item is AgentToolGroup =>
              (AGENT_TOOL_GROUPS as readonly string[]).includes(item),
            )
            .filter((item) => item !== "core")
            .slice(0, 10),
        ),
      ]
    : [];
  const skills = Array.isArray(parsed.skills)
    ? [
        ...new Set(
          parsed.skills
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .map((item) => item.trim().toLowerCase().slice(0, 80)),
        ),
      ].slice(0, 3)
    : [];
  const approach =
    typeof parsed.approach === "string" && parsed.approach.trim()
      ? parsed.approach.trim().slice(0, 800)
      : "";
  const needsExhaustiveEvidence = parsed.needsExhaustiveEvidence === true;
  const normalizedRequest =
    typeof parsed.normalizedRequest === "string" && parsed.normalizedRequest.trim()
      ? parsed.normalizedRequest.trim().slice(0, 800)
      : "";
  const behaviors = parseBehaviors(parsed.behaviors);
  const constraints = Array.isArray(parsed.constraints)
    ? parsed.constraints
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 300))
        .slice(0, 10)
    : [];
  const ambiguities = parseAmbiguities(parsed.ambiguities);
  const confidenceValue = Number(parsed.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : 0.5;
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

  const baseIntent = applyRunPreviewIntent(
    {
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
      context,
      history,
      toolGroups,
      skills,
      normalizedRequest,
      behaviors,
      constraints,
      ambiguities,
      confidence,
      approach,
      needsExhaustiveEvidence,
      assumptions,
    },
    instruction,
  );
  return forceExplicitEditIntent(
    suppressRedundantClarification(baseIntent, instruction, analysis),
    instruction,
  );
}

async function resolveIntentModel(options: IntentOptions) {
  const settings = await getPublicSettings().catch(() => null);
  const fastRole = settings?.agentRoles.find((role) => role.role === "fast");
  // Use the model the user selected for this run first. The fast role is only
  // a fallback for callers that do not pass an explicit provider/model.
  let config = options.provider
    ? await resolveProvider(options.provider, options.model).catch(async () => {
        const fallback = await resolveProvider(fastRole?.provider, fastRole?.model).catch(() => null);
        return fallback ?? resolveAgentRole("main", { provider: options.provider, model: options.model });
      })
    : await resolveAgentRole("main", {
        provider: options.provider,
        model: options.model,
      }).catch(async () => {
        // Only fall back to the fast/free role when the main model is unusable.
        return (await resolveProvider(fastRole?.provider, fastRole?.model).catch(() => null)) ??
          resolveProvider(options.provider, options.model);
      });
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
function forceExplicitEditIntent(
  intent: IntentAnalysis,
  instruction: string,
): IntentAnalysis {
  if (intent.kind === "scaffold" || intent.kind === "question") return intent;
  // "bozma"/"dokunma" is a preservation constraint, not a negation of the edit.
  if (/(?:kaldırma|silme|değiştirme|ekleme)\b/i.test(instruction)) return intent;
  const explicitEdit =
    /(?:^|[\s,.;:])(?:kaldır|sil|gizle|ekle|değiştir|güncelle|taşı|birleştir|düzenle|yenile|remove|delete|hide|add|change|update|move|merge|rename|fix|repair)\b/i.test(
      instruction,
    );
  if (!explicitEdit) return intent;
  if (intent.kind === "edit" && !intent.needsClarification) return intent;
  return {
    ...intent,
    kind: "edit",
    // Keep a genuine clarification (distinct options); redundant ones were
    // already removed by suppressRedundantClarification.
    assumptions: [
      ...intent.assumptions,
      "The request contains explicit change verbs; treat it as an edit instead of an analysis question.",
    ].slice(0, 8),
  };
}

function suppressRedundantClarification(
  intent: IntentAnalysis,
  instruction: string,
  analysis: AnalysisResult,
): IntentAnalysis {
  if (!intent.needsClarification) return intent;
  // If the offered options only differ in layout/cosmetic wording, the choice
  // is not worth blocking the task. Proceed with the first concrete option.
  const suffixes = (intent.options ?? [])
    .map((option) => option.instructionSuffix.trim().toLowerCase())
    .filter(Boolean);
  if (suffixes.length >= 2) {
    const prefix = suffixes[0].slice(0, Math.min(36, suffixes[0].length));
    if (
      prefix.length >= 16 &&
      suffixes.every((suffix) => suffix.startsWith(prefix))
    ) {
      return {
        ...intent,
        needsClarification: false,
        question: "",
        options: [],
        assumptions: [
          ...intent.assumptions,
          `Clarification options only varied in layout; proceeding with: ${intent.options?.[0]?.label ?? "the first option"}.`,
        ].slice(0, 8),
      };
    }
  }
  const explicitRemoval =
    /(?:kaldır|sil|gizle|remove|hide|delete)/i.test(instruction) &&
    /(?:hedef|puan|hud|bar|işlem|gösterge|target|score|display)/i.test(instruction);
  const explicitKeep = /(?:kalsın|kalsin|koru|bozma|keep|preserve)/i.test(instruction);
  if (explicitRemoval && explicitKeep) {
    return {
      ...intent,
      needsClarification: false,
      question: "",
      options: [],
      assumptions: [
        ...intent.assumptions,
        "The request already states what to remove and what to keep; proceed with the stated UI change.",
      ].slice(0, 8),
    };
  }
  const question = `${intent.question} ${(intent.options ?? [])
    .map((option) => option.label)
    .join(" ")}`.toLowerCase();
  const shooting = /(?:shoot|shooting|fire|ateş)/i.test(question) && /(?:shoot|shooting|fire|ateş)/i.test(instruction);
  const hasShooting = (analysis.symbols ?? []).some((symbol) =>
    /(?:spawnBullet|updateBullets|bindFireControls|setFiring)/i.test(symbol.name),
  );
  if (shooting && hasShooting) {
    return {
      ...intent,
      needsClarification: false,
      question: "",
      options: [],
      assumptions: [
        ...intent.assumptions,
        "Existing shooting implementation (bindFireControls/Space/pointer) is reused; do not ask how shooting should work.",
      ].slice(0, 8),
    };
  }
  const presentationRequest =
    /(?:daha görünür|daha sık|daha belirgin|more visible|more frequent|more prominent)/i.test(instruction);
  const presentationQuestion =
    /(?:görünür|visible|frequent|sık|prominent|appearance|görünüm)/i.test(question);
  if (presentationRequest && presentationQuestion) {
    return {
      ...intent,
      needsClarification: false,
      question: "",
      options: [],
      assumptions: [
        ...intent.assumptions,
        "Use sensible presentation defaults (larger, brighter, higher contrast, more frequent); do not block on a cosmetic choice.",
      ].slice(0, 8),
    };
  }
  const existingBehavior = /(?:spawnBullet|pickMeteorTier|updateBullets|existing|already|mevcut)/i.test(
    intent.assumptions.join(" "),
  );
  const concreteFeature = /(?:shoot|shooting|fire|meteor|hit|size|speed|item|comedy)/i.test(instruction);
  const questionFeature = /(?:shoot|shooting|fire|meteor|hit|size|speed|work|behave|control)/i.test(question);
  if (existingBehavior && concreteFeature && questionFeature) {
    return {
      ...intent,
      needsClarification: false,
      question: "",
      options: [],
      assumptions: [
        ...intent.assumptions,
        "The request already specifies the behavior and the existing implementation/defaults apply; do not block on an implementation choice.",
      ].slice(0, 8),
    };
  }
  return intent;
}

function preserveNegations(intent: IntentAnalysis, instruction: string): IntentAnalysis {  const matches = [
    ...instruction.matchAll(
      /(?:yeniden|tekrar)\s+ekleme|\bekleme\b|kaldırma|silme|değiştirme|\bdo not\s+(?:add|change|remove|delete|rewrite)\b|\bdon't\s+(?:add|change|remove|delete|rewrite)\b|no new/gi,
    ),
  ].map((match) => match[0].trim());
  const unique = [...new Set(matches.map((item) => item.toLowerCase()))];
  if (unique.length === 0) return intent;
  const text = `${intent.understanding} ${intent.assumptions.join(" ")}`.toLowerCase();
  const already = /(?:ekleme|do not add|without adding|re-add|don't add|no new)/i.test(text);
  return {
    ...intent,
    understanding: already
      ? intent.understanding
      : `${intent.understanding} Constraint: ${unique.join("; ")}.`.slice(0, 500),
    assumptions: [
      ...intent.assumptions,
      `Hard constraint from the request: ${unique.join("; ")}; do not turn it into a positive action.`,
    ].slice(0, 8),
  };
}

/**
 * “Run it / activate the interface / show the preview” is a run request on the
 * active project. It must not become a project-switch question or a code edit.
 */
function applyRunPreviewIntent(intent: IntentAnalysis, instruction: string): IntentAnalysis {
  if (!requestIsRunPreview(instruction)) return intent;
  const writeRequest =
    /\b(?:ekle|ekley|düzelt|değiştir|kaldır|sil|güncelle|oluştur|fix|add|change|remove|delete|update|edit|refactor|implement)\w*/i.test(
      instruction,
    );
  if (writeRequest) return intent;
  return {
    ...intent,
    kind: "run",
    needsClarification: false,
    question: "",
    options: [],
    mode: "single",
    scope: "small",
    verification: "browser",
    context: intent.context === "none" ? "focused" : intent.context,
    toolGroups: [...new Set([...intent.toolGroups, "command", "browser"] as AgentToolGroup[])],
    approach:
      intent.approach ||
      "Start the detected dev server for the active project and show the real interface in the preview.",
    assumptions: [
      ...intent.assumptions,
      "Run/preview request on the active project: start its server and show the preview; do not suggest another project.",
    ].slice(0, 8),
  };
}

export function projectMismatchClarification(
  intent: IntentAnalysis,
  instruction: string,
  analysis: AnalysisResult,
  recent: RecentProject[],
  language?: string,
): IntentAnalysis | null {
  if (intent.kind === "scaffold") return null;
  if (intent.context === "none") return null;
  // A new app in an empty/docs-only project belongs to the active project.
  if (isEffectivelyEmptyProject(analysis)) return null;
  if (analyzeRequestFrame(instruction, analysis, intent.language || language).newBuild) {
    return null;
  }
  if (!requestMentionsUi(instruction)) return null;
  // Run/preview/start is always about the active project.
  if (requestIsRunPreview(instruction)) return null;
  // “Does this project have a UI?” is a current-project audit, not a request
  // for another project. Let the agent answer it against the active project.
  if (requestIsCurrentProjectScope(instruction)) return null;
  if (analysisHasUi(analysis)) return null;

  const candidates = recent
    .filter((project) => project.id !== analysis.id && projectSummaryHasUi(project))
    .slice(0, 4);
  const turkish = (intent.language || language || "").toLowerCase().startsWith("tr");
  const question = turkish
    ? `Aktif proje “${analysis.projectName}” içinde bu isteğe uygun bir arayüz bulunamadı. İstek başka bir projeye ait olabilir. Hangi projeyi kullanayım?`
    : `The active project “${analysis.projectName}” does not appear to have a matching interface. This request may belong to another project. Which project should I use?`;
  const choices: IntentOption[] = candidates.map((project) => ({
    id: `project:${project.id}`,
    label: project.projectName,
    instructionSuffix: "",
    projectId: project.id,
    projectName: project.projectName,
  }));
  const modelChoices = (intent.options ?? []).filter(
    (option) =>
      !/başka bir|baska bir|another|other project|different project|başka proje|baska proje|wrong project|yanlış proje|yanlis proje|proje yolu|project path/i.test(
        `${option.label} ${option.instructionSuffix}`,
      ),
  );
  choices.push(...modelChoices);
  choices.push({
    id: "search-anyway",
    label: turkish ? "Yine de bu projede ara" : "Search this project anyway",
    instructionSuffix: turkish
      ? "Bu projede aramaya devam et; uygun bir arayüz bulunamazsa kısaca söyle, buton uydurma."
      : "Search the current project anyway; if no matching interface is found, say so briefly and do not invent buttons.",
  });
  return {
    ...intent,
    needsClarification: true,
    question,
    options: choices,
  };
}

async function applyProjectMismatchGuard(
  intent: IntentAnalysis,
  instruction: string,
  analysis: AnalysisResult,
  options: IntentOptions,
): Promise<IntentAnalysis> {
  if (options.clarified === true) return intent;
  const mismatch = projectMismatchClarification(
    intent,
    instruction,
    analysis,
    await listRecent(),
    options.language,
  );
  return mismatch ?? intent;
}

const CONTINUATION_PATTERN =
  /^(listeyi|listeyi yap|listeyi uygula|listeyi uygula|yap|yapalım|yapalim|devam|devam et|uygula|onayla|başla|basla|tamam|ok|do it|continue|go ahead|apply it|the list|bunu yap|bunu uygula|hepsini yap|tümünü yap|tumunu yap)\b/i;

export function isContinuationInstruction(instruction: string): boolean {
  const text = instruction.trim();
  return text.length > 0 && text.length <= 40 && CONTINUATION_PATTERN.test(text);
}

const MULTI_PART_SIGNAL =
  /\b(?:bir ?kaç|birkaç|çeşitli|several|multiple|bir dizi)\b|;\s*\S|[0-9]+[.)]\s+/i;

/**
 * A low-confidence or parse-fallback intent must not silently collapse a
 * multi-part request into one patch. The UI already has a confirmation card;
 * this helper decides when it must be shown and when the loop must plan
 * instead of taking the single-patch shortcut.
 */
export function intentNeedsConfirmation(
  intent: IntentAnalysis,
  instruction: string,
): { needed: boolean; reason: string } {
  if (!["edit", "scaffold", "run"].includes(intent.kind)) {
    return { needed: false, reason: "" };
  }
  const fallback = (intent.assumptions ?? []).some((assumption) =>
    /could not parse|could not run|one focused task/i.test(assumption),
  );
  if (fallback) {
    return {
      needed: true,
      reason: "Intent analysis fell back after a parse or run failure; the interpreted behaviors may be incomplete.",
    };
  }
  const multiPart = MULTI_PART_SIGNAL.test(instruction);
  const collapsedMultiPart = multiPart && (intent.behaviors?.length ?? 0) <= 1;
  if (collapsedMultiPart) {
    return {
      needed: true,
      reason: "The request names several changes but was interpreted as one behavior.",
    };
  }
  const confidence = intent.confidence ?? 0.6;
  if (confidence < 0.6) {
    return {
      needed: true,
      reason: `Intent confidence is low (${Math.round(confidence * 100)}%).`,
    };
  }
  return { needed: false, reason: "" };
}

/**
 * The endpoint-level gate: resuming, manual retry, a clarified request and an
 * explicit confirmation suppress the card. Everything else defers to the
 * intent-level heuristic above.
 */
export function shouldRequestIntentConfirmation(options: {
  intent: IntentAnalysis;
  instruction: string;
  resuming?: boolean;
  retryFailed?: boolean;
  confirmed?: boolean;
  clarified?: boolean;
  replan?: boolean;
}): { needed: boolean; reason: string } {
  if (
    options.resuming ||
    options.retryFailed ||
    options.confirmed ||
    options.clarified ||
    options.replan
  ) {
    return { needed: false, reason: "" };
  }
  return intentNeedsConfirmation(options.intent, options.instruction);
}

/**
 * Resolve a short reference ("listeyi yap", "devam et") to the last
 * substantive user request so the previous list/plan is not re-typed,
 * re-analyzed or stacked with the new message.
 */
export function resolveContinuationGoal(
  instruction: string,
  history?: { role: "user" | "assistant"; content: string }[],
): { goal: string; history: { role: "user" | "assistant"; content: string }[] } | null {
  if (!isContinuationInstruction(instruction) || !history || history.length === 0) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== "user") continue;
    const content = message.content.trim();
    if (content.length < 40) continue;
    const taskLike =
      /\b(yap|yapıl|ekle|ekley|oluştur|olustur|güncelle|guncelle|değiştir|degistir|istiyorum|add|implement|update|create|build|make|change)\b/i.test(
        content,
      ) || /^\s*\d{1,2}[.)]\s+/m.test(content);
    if (!taskLike) continue;
    return { goal: content, history: history.slice(0, index) };
  }
  return null;
}

export function extractNumberedListIntent(
  instruction: string,
  analysis: AnalysisResult,
  options: IntentOptions,
): IntentAnalysis | null {
  const lines = instruction.split(/\r?\n/);
  const items: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const match = line.match(/^\s*(\d{1,2})[.)]\s+(.+?)\s*$/);
    if (match) {
      if (current) items.push(current);
      current = { title: match[2].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) items.push(current);
  if (items.length < 2 || items.length > 8) return null;
  if (items.some((item) => item.title.endsWith("?"))) return null;
  if (!/\b(yap|yapıl|ekle|ekley|oluştur|olustur|güncelle|guncelle|değiştir|degistir|istiyorum|add|implement|update|create|build|make|change)\b/i.test(instruction)) {
    return null;
  }

  const gameProject =
    /game|oyun|canvas|maze|labirent/i.test(
      `${analysis.projectName} ${instruction} ${analysis.files.map((file) => file.path).join(" ")}`,
    );
  const ui = gameProject || analysisHasUi(analysis) || requestMentionsUi(instruction);
  const surface: IntentBehavior["surface"] = gameProject ? "game" : ui ? "ui" : "other";
  const newProject =
    /\b(yeni proje|sıfırdan|sifirdan|from scratch|new project|scaffold|proje oluştur)\b/i.test(
      instruction,
    ) && analysis.files.length <= 8;
  const titles = items.map((item) => item.title.replace(/^#+\s*/, "").slice(0, 120));
  const behaviors: IntentBehavior[] = items.map((item, index) => ({
    id: `b${index + 1}`,
    action: "update",
    surface,
    target: item.title.replace(/^#+\s*/, "").slice(0, 120),
    details: item.body.join(" ").replace(/\s+/g, " ").trim().slice(0, 600),
    acceptance: `${item.title.slice(0, 80)} is implemented and verified on the real page.`,
  }));
  const constraints = instruction
    .split(/\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        /\b(bozma|bozmay|koru|korun|değiştirme|degistirme|sadece|only|do not|preserve)\b/i.test(line),
    )
    .slice(0, 4);
  const verification: IntentVerification = ui
    ? "browser"
    : analysis.tooling?.buildCommands?.length
      ? "build"
      : "none";
  const areas = likelyProjectAreas(analysis, instruction);
  return {
    kind: newProject ? "scaffold" : "edit",
    understanding: `İstenen güncelleme: ${titles.join("; ")}.`.slice(0, 400),
    language: options.language ?? "unknown",
    needsClarification: false,
    question: "",
    options: [],
    normalizedRequest: `Apply these updates: ${titles.join("; ")}.`.slice(0, 240),
    behaviors,
    constraints,
    ambiguities: [],
    confidence: items.length >= 3 ? 0.86 : 0.8,
    scope: items.length >= 3 ? "large" : "medium",
    mode: "loop",
    areas:
      areas.length > 0
        ? areas
        : analysis.files
            .filter((file) => /\.(?:html?|css|jsx?|tsx?|vue|svelte|php|py)$/i.test(file.path))
            .slice(0, 6)
            .map((file) => file.path),
    verification,
    context: "project",
    history: "recent",
    toolGroups: ["edit", ...(ui ? (["browser", "command"] as AgentToolGroup[]) : [])],
    skills: [],
    approach:
      "Implement the numbered sections as one checklist/build session; verify the main flow on the real page.",
    needsExhaustiveEvidence: false,
    assumptions: [
      "The numbered list was interpreted as independent behaviors.",
      ...(gameProject
        ? ["Unspecified game details use the simplest consistent implementation."]
        : []),
    ],
  };
}

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
  const listIntent = extractNumberedListIntent(instruction, analysis, options);
  if (listIntent) {
    return {
      intent: listIntent,
      provider: "heuristic",
      model: "list-extractor",
      totalTokens: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
    };
  }
  const config = await resolveIntentModel(options);
  const frame = analyzeRequestFrame(instruction, analysis, options.language);
  const frameFacts = requestFrameFacts(frame);
  const domainMatch = frame.domain ?? matchDomainCards(instruction, { limit: 1 })[0];
  const domainFacts = domainMatch ? domainPromptFacts(domainMatch) : "";
  const skillList = await listSkills(analysis.rootPath, projectId).catch(() => null);
  const skillFeedback = await readSkillFeedback(analysis.rootPath).catch(() => null);
  const skillIndex = (skillList?.skills ?? [])
    .filter((skill) => skill.enabled)
    .slice(0, 20)
    .map((skill) => {
      const slug = skillMentionSlug(skill.name);
      const rating = skillFeedbackScore(skillFeedback?.skills[slug]);
      return `${slug}${rating ? ` (rating ${rating > 0 ? "+" : ""}${rating})` : ""}: ${(skill.description || "No description.").slice(0, 140)}`;
    })
    .join("\n");
  const messages = [
    { role: "system" as const, content: systemPrompt() },
    {
      role: "user" as const,
      content: await userPrompt(
        analysis,
        instruction,
        { ...options, skillIndex },
        domainFacts,
        frameFacts,
      ),
    },
  ];
  let tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const addUsage = (a: typeof tokenUsage, b: typeof tokenUsage): typeof tokenUsage => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  });
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
          tokenUsage = addUsage(tokenUsage, usage);
        },
      },
    );

  let raw: string;
  try {
    raw = await ask();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    // Do not lose the user's message because the small intent call was rate
    // limited. Continue with a safe heuristic intent; the executor can still
    // inspect the project and ask for clarification later if needed.
    const fallback = fallbackIntentFromFrame(frame, instruction);
    fallback.assumptions = [
      ...fallback.assumptions,
      `Intent analysis could not run (${config.id}/${config.model}: ${message.slice(0, 240)}). Continuing with the deterministic request frame.`,
    ].slice(0, 8);
    console.warn(`[intent] model call failed: ${message}`);
    return {
      intent: fallback,
      provider: config.id,
      model: config.model,
      totalTokens: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: undefined,
    };
  }

  let intent: IntentAnalysis;
  try {
    intent = parseIntentResponse(raw, analysis, instruction, options.clarified);
  } catch {
    try {
      raw = await ask(true);
      intent = parseIntentResponse(raw, analysis, instruction, options.clarified);
    } catch {
      try {
        // The full prompt (project facts + symbol hints) can make a small model
        // return prose or truncated JSON. Retry with a minimal prompt that still
        // lets it choose an area, then fall back only if that also fails.
        const minimal = await chat(
          config,
          [
            { role: "system" as const, content: systemPrompt() },
            {
              role: "user" as const,
              content: [
                `Project files: ${analysis.files
                  .map((file) => file.path)
                  .slice(0, 20)
                  .join(", ")}`,
                `User request:\n${instruction.trim()}`,
                `Interface language: ${options.language ?? "unknown"}`,
                `Request frame (authoritative):\n${frameFacts}`,
                domainFacts
                  ? `Domain reference (authoritative):\n${domainFacts.slice(0, 2_000)}`
                  : "",
                "Return only the JSON object with the schema. No prose, no Markdown.",
              ].join("\n\n"),
            },
          ],
          {
            maxTokens: 2_200,
            temperature: 0,
            timeoutMs: TIMEOUT_MS,
            signal: options.signal,
            onUsage: (usage) => {
              tokenUsage = addUsage(tokenUsage, usage);
            },
          },
        );
        intent = parseIntentResponse(minimal, analysis, instruction, options.clarified);
      } catch {
        intent = fallbackIntentFromFrame(frame, instruction);
        intent.assumptions = [
          ...intent.assumptions,
          "Intent analyst could not parse its reply; used the deterministic request frame.",
        ].slice(0, 8);
        console.warn("[intent] parse failed twice; using request frame");
      }
    }
  }

  intent = ensureIntentSpec(intent, instruction);
  intent = applyRequestFrame(intent, frame);
  intent = suppressRedundantClarification(intent, instruction, analysis);
  intent = forceExplicitEditIntent(intent, instruction);
  intent = preserveNegations(intent, instruction);
  // Every conversation has an active project, even when it is empty. Never ask
  // "which project should I use?"; adapt to the current project instead.
  intent = applyDomainClarification(
    intent,
    instruction,
    domainMatch,
    options.language,
    options.clarified,
  );
  if (intent.areas.length === 0) {
    const areas = likelyProjectAreas(analysis, instruction);
    if (areas.length > 0) intent = { ...intent, areas };
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
