import type { AiTokenUsage } from "./ai";
import type { BrowserCheckStep } from "./browserCheck";

export interface DiagnosisFact {
  claim: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface DiagnosisDesign {
  name: string;
  summary: string;
  pros: string[];
  cons: string[];
  files: string[];
  risk: "low" | "medium" | "high";
}

export interface DiagnosisFailureMode {
  scenario: string;
  impact: string;
  mitigation: string;
}

export interface DiagnosisVerification {
  command?: string;
  /** Real entry page for browser steps. */
  path?: string;
  /** Concrete browser_check steps; run automatically as the required scenario. */
  steps?: BrowserCheckStep[];
  checks: string[];
  expected: string[];
}

/**
 * Read-only analysis produced before planning/editing. It is deliberately
 * separate from the plan/tasks: it explains *why* and *what can go wrong*, then
 * the planner turns it into executable tasks.
 */
export interface ProjectDiagnosis {
  version: 1;
  goal: string;
  createdAt: string;
  provider?: string;
  model?: string;
  problem: string;
  rootCause: string;
  confidence: number;
  facts: DiagnosisFact[];
  constraints: string[];
  unknowns: string[];
  callSites: string[];
  includes: string[];
  impact: string[];
  designs: DiagnosisDesign[];
  chosenDesign: string;
  rationale: string;
  failureModes: DiagnosisFailureMode[];
  rollback: string;
  verification: DiagnosisVerification;
  todos: string[];
  tokenUsage?: AiTokenUsage;
  costUsd?: number;
}

export interface ProjectDiagnosisView {
  diagnosis: ProjectDiagnosis | null;
  brief: string;
  paths: { json: string; markdown: string };
}
