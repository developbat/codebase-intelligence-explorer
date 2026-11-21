export type IntentKind = "edit" | "question" | "run" | "scaffold" | "analyze";
export type IntentScope = "trivial" | "small" | "medium" | "large";
export type IntentMode = "single" | "loop";
export type IntentVerification = "none" | "browser" | "test" | "build";

export interface IntentOption {
  id: string;
  label: string;
  /** Text appended to the original instruction when the user picks this option. */
  instructionSuffix: string;
}

export interface IntentAnalysis {
  kind: IntentKind;
  understanding: string;
  language: string;
  needsClarification: boolean;
  question?: string;
  options?: IntentOption[];
  scope: IntentScope;
  mode: IntentMode;
  areas: string[];
  verification: IntentVerification;
  assumptions: string[];
}

export interface ClarificationRequest {
  question: string;
  options: IntentOption[];
  original: string;
}

export const INTENT_KINDS: IntentKind[] = ["edit", "question", "run", "scaffold", "analyze"];
export const INTENT_SCOPES: IntentScope[] = ["trivial", "small", "medium", "large"];
export const INTENT_MODES: IntentMode[] = ["single", "loop"];
export const INTENT_VERIFICATIONS: IntentVerification[] = ["none", "browser", "test", "build"];
