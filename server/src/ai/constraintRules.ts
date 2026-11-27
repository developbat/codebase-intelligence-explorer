import type { ProjectBrainConstraint } from "../../../shared/projectBrain";

export interface ConstraintAuditInput {
  constraints: ProjectBrainConstraint[];
  changedFiles: string[];
  summary: string;
  /** Current task goal, so task-scoped constraints do not leak into other tasks. */
  goal?: string;
  /** Project file paths, used to map vague "do not touch app" constraints to existing dirs. */
  files?: string[];
}

export interface ConstraintAudit {
  ok: boolean;
  violations: string[];
  warnings: string[];
}

const PATH_PATTERN =
  /[\w./@-]+\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|sass|less|php|py|go|rs|java|kt|kts|cs|rb|swift|scala|dart|json|toml|ya?ml|md|txt|sh|sql)\b/gi;
const DIR_PATTERN =
  /\b(?:src|app|client|server|api|docs|web|frontend|backend|mobile|ios|android|lib|packages|components|services|routes)\//gi;
const UI_DIRS = ["app/", "client/", "web/", "frontend/", "mobile/", "ios/", "android/"];
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
];

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function pathMatches(file: string, rule: string): boolean {
  const target = normalize(file);
  const clean = normalize(rule);
  if (!clean) return false;
  if (clean.endsWith("/")) return target.startsWith(clean) || target.includes(`/${clean}`);
  if (!/\.[a-z0-9]+$/i.test(clean)) {
    return target === clean || target.startsWith(`${clean}/`) || target.includes(`/${clean}/`);
  }
  return target === clean || target.endsWith(`/${clean}`);
}

function hasSecret(text: string): string | null {
  for (const pattern of SECRET_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0];
  }
  return null;
}

function constraintIsOnly(text: string): boolean {
  return /\b(?:only|sadece|yalnızca|yalnizca)\b/i.test(text);
}

function constraintIsForbidden(text: string): boolean {
  return /\b(?:do not|don't|never|avoid|must not)\b|dokunma|değiştirme|degistirme|silme|dokunmayın/i.test(
    text,
  );
}

function isServerOnly(text: string): boolean {
  return /\bserver[- ]side only\b|\bsadece sunucu(?:da| tarafında)?\b/i.test(text);
}

function isNoSecrets(text: string): boolean {
  return (
    /(?:password|parola|secret|token|credential|api[_-]?key)/i.test(text) &&
    /(?:not|never|no|gösterme|gosterme|görünme|gizle|expose|log)/i.test(text)
  );
}

function extractPaths(text: string): string[] {
  return unique([...(text.match(PATH_PATTERN) ?? []), ...(text.match(DIR_PATTERN) ?? [])]);
}

/**
 * Deterministic guard for explicit user constraints. Vague constraints produce
 * warnings; only clear path/secret violations fail the task.
 */
export function auditProjectConstraints(input: ConstraintAuditInput): ConstraintAudit {
  const changed = unique(input.changedFiles);
  const files = unique(input.files ?? []);
  const constraints = input.constraints.filter(
    (constraint) =>
      constraint.scope !== "task" ||
      !constraint.goal ||
      !input.goal ||
      constraint.goal.trim() === input.goal.trim(),
  );
  const violations: string[] = [];
  const warnings: string[] = [];
  const allowed: string[] = [];
  const forbidden: string[] = [];
  let noSecrets = false;

  for (const constraint of constraints) {
    const text = constraint.text;
    const clauses = text
      .split(/[;\n]+/)
      .map((clause) => clause.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      const paths = extractPaths(clause);
      if (paths.length === 0) continue;
      // A forbidden clause wins over a nearby "only" word: "do not touch
      // app.js; only change game.js" must not allow app.js.
      if (constraintIsForbidden(clause)) {
        forbidden.push(...paths);
      } else if (constraintIsOnly(clause)) {
        allowed.push(...paths);
      }
    }
    if (
      isServerOnly(text) ||
      /do not touch (?:the )?(?:application|app|client)/i.test(text) ||
      /uygulama(?:ya| koduna)? dokunma/i.test(text)
    ) {
      const existingUi = UI_DIRS.filter((directory) =>
        files.some((file) => normalize(file).startsWith(directory) || normalize(file).includes(`/${directory}`)),
      );
      const appFiles = files.filter((file) => /(^|\/)app\.[a-z0-9]+$/i.test(normalize(file)));
      if (existingUi.length > 0) {
        forbidden.push(...existingUi);
      } else if (appFiles.length > 0) {
        forbidden.push(...appFiles);
      } else {
        warnings.push(`Could not map "${text}" to concrete UI paths; verify changed files manually.`);
      }
    }
    if (isNoSecrets(text)) noSecrets = true;
  }

  for (const file of changed) {
    if (allowed.length > 0 && !allowed.some((rule) => pathMatches(file, rule))) {
      violations.push(
        `Constraint allows only ${allowed.join(", ")}, but the task changed ${file}.`,
      );
    }
    const matchedForbidden = forbidden.find((rule) => pathMatches(file, rule));
    if (matchedForbidden) {
      violations.push(
        `Constraint forbids ${matchedForbidden}, but the task changed ${file}.`,
      );
    }
  }

  const secret = hasSecret(input.summary);
  if (secret) {
    violations.push(
      `The finish summary contains a credential-like value (${secret.slice(0, 12)}…). Do not expose secrets in responses or logs.`,
    );
  } else if (noSecrets && /(?:password|parola|secret|token|credential)\s*[:=]\s*\S+/i.test(input.summary)) {
    violations.push(
      "A no-secret constraint is active, but the finish summary appears to include a password/token. Remove it before finishing.",
    );
  }

  return { ok: violations.length === 0, violations: unique(violations), warnings: unique(warnings) };
}
