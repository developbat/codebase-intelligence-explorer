import type { AnalysisResult, AnalysisSummary } from "./types";

export interface ProjectUiFacts {
  files?: readonly { path: string }[];
  frameworks?: readonly string[];
  languages?: Readonly<Record<string, number>>;
}

const UI_FILE =
  /\.(?:html?|xhtml|css|scss|sass|less|styl|jsx|tsx|vue|svelte|astro|tmpl|tpl|ejs|hbs|handlebars|pug|twig|liquid|blade\.php)$/i;

const UI_FRAMEWORK =
  /\b(?:react|react native|expo|vue|nuxt|svelte|sveltekit|next\.?js|angular|solid|astro|static html|laravel|django|flask|rails|flutter)\b/i;

const UI_REQUEST =
  /\b(?:game|games|play|button|buttons|ui|ux|screen|screens|page|pages|html|css|frontend|front-end|canvas|layout|interface)\b|oyun\w*|oyna\w*|buton\w*|arayüz\w*|ekran\w*|sayfa\w*|görsel\w*|tasarım\w*/i;

const CURRENT_PROJECT_REQUEST =
  /\b(?:this|current|the)\s+project\b|projede|bu projede|proje içinde|proje icinde|depoda|repository|repo\b|var mı|var mi|is there|does (?:it|this project) (?:have|contain)|içeriyor mu|icermiyor mu/i;

export function requestMentionsUi(text: string): boolean {
  return UI_REQUEST.test(text);
}

export function requestIsCurrentProjectScope(text: string): boolean {
  return CURRENT_PROJECT_REQUEST.test(text);
}

export function projectHasUi(facts: ProjectUiFacts): boolean {
  if (facts.files?.some((file) => UI_FILE.test(file.path))) return true;
  if (facts.frameworks?.some((framework) => UI_FRAMEWORK.test(framework))) return true;
  if (facts.languages) {
    const uiLanguages = ["HTML", "CSS", "Vue", "Svelte"];
    if (uiLanguages.some((language) => (facts.languages?.[language] ?? 0) > 0)) {
      return true;
    }
  }
  return false;
}

export function projectSummaryHasUi(
  summary: Pick<AnalysisSummary, "frameworks" | "languages">,
): boolean {
  return projectHasUi({
    frameworks: summary.frameworks,
    languages: summary.languages,
  });
}

export function analysisHasUi(analysis: AnalysisResult): boolean {
  return projectHasUi({
    files: analysis.files,
    frameworks: analysis.frameworks,
    languages: analysis.languages,
  });
}

export interface ProjectMismatch {
  mismatch: boolean;
  uiRequest: boolean;
  hasUi: boolean;
}

export function detectProjectMismatch(
  text: string,
  facts: ProjectUiFacts,
): ProjectMismatch {
  const uiRequest = requestMentionsUi(text);
  const hasUi = projectHasUi(facts);
  const currentScope = requestIsCurrentProjectScope(text);
  return { mismatch: uiRequest && !hasUi && !currentScope, uiRequest, hasUi };
}
