import fs from "node:fs/promises";
import path from "node:path";
import type { IntentAnalysis } from "../../shared/intent";
import { isSiteInspection, resolveActionPlan } from "./ai/actions";
import { suggestToolsForInstruction } from "./ai/toolRegistry";
import { resolveToolGroups } from "./ai/service";

interface Case {
  instruction: string;
  kind: IntentAnalysis["kind"];
  action: string;
  groups?: string[];
  suggested?: string[];
  site?: boolean;
}

const CASES: Case[] = [
  {
    instruction: "siteyi incele",
    kind: "analyze",
    action: "verify",
    groups: ["browser"],
    suggested: ["browser_check", "run_test_scenario", "game_check"],
    site: true,
  },
  {
    instruction: "sitedeki butonları listele",
    kind: "analyze",
    action: "list",
    suggested: ["extract_entities"],
  },
  {
    instruction: "testleri çalıştır",
    kind: "analyze",
    action: "verify",
    groups: ["command"],
    suggested: ["run_command", "run_test_scenario"],
  },
  {
    instruction: "sunucuyu başlat",
    kind: "run",
    action: "run",
    groups: ["command"],
    suggested: ["run_command"],
  },
  {
    instruction: "package.json dosyasını oku",
    kind: "analyze",
    action: "explain",
    suggested: ["read_file", "json_query"],
  },
  {
    instruction: "Excel raporu oluştur",
    kind: "edit",
    action: "edit",
    groups: ["edit"],
    suggested: ["create_document"],
  },
  {
    instruction: "hata nerede",
    kind: "analyze",
    action: "locate",
    suggested: ["project_search", "find_in_file", "read_file"],
  },
  {
    instruction: "kullanıcı girişini test et",
    kind: "analyze",
    action: "verify",
    groups: ["browser"],
    suggested: ["browser_check", "run_test_scenario", "game_check"],
  },
];

function intent(kind: IntentAnalysis["kind"]): IntentAnalysis {
  return {
    kind,
    understanding: "eval",
    language: "tr",
    needsClarification: false,
    scope: "small",
    mode: "single",
    areas: [],
    verification: "none",
    context: "project",
    history: "none",
    toolGroups: [],
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: [],
  };
}

async function main(): Promise<void> {
  const results: {
    instruction: string;
    ok: boolean;
    action: string;
    groups: string[];
    suggested: string[];
    errors: string[];
  }[] = [];
  for (const item of CASES) {
    const plan = resolveActionPlan(item.instruction, intent(item.kind));
    const groups = resolveToolGroups(intent(item.kind), item.instruction, "build");
    if (plan.needsBrowser && !groups.includes("browser")) groups.push("browser");
    if (plan.needsCommand && !groups.includes("command")) groups.push("command");
    const suggested = suggestToolsForInstruction(item.instruction, groups, 8);
    const errors: string[] = [];
    if (plan.action !== item.action) {
      errors.push(`action ${plan.action} !== ${item.action}`);
    }
    for (const group of item.groups ?? []) {
      if (!groups.includes(group as never)) errors.push(`missing group ${group}`);
    }
    if (item.suggested && !item.suggested.some((tool) => suggested.includes(tool))) {
      errors.push(`suggestions did not include one of ${item.suggested.join(", ")}`);
    }
    if (item.site && !isSiteInspection(item.instruction)) {
      errors.push("site inspection was not detected");
    }
    results.push({
      instruction: item.instruction,
      ok: errors.length === 0,
      action: plan.action,
      groups,
      suggested,
      errors,
    });
  }
  const failed = results.filter((result) => !result.ok);
  const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  const reportsDir = path.join(process.cwd(), "fixtures", "agent-eval", "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `tool-use-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} · ${result.instruction}\n  action=${result.action} · groups=${result.groups.join("+")} · suggested=${result.suggested.join(", ")}${result.errors.length ? `\n  ${result.errors.join("; ")}` : ""}`,
    );
  }
  console.log(`\n${report.passed}/${report.total} tool-use checks passed`);
  console.log(`Report: ${reportPath}`);
  if (failed.length > 0) process.exitCode = 1;
}

void main();
