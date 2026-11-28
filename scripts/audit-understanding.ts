import fs from "node:fs/promises";
import path from "node:path";
import { analyzeProject } from "../server/src/analyzer";
import { saveAnalysis, removeAnalysis } from "../server/src/store";
import { analyzeIntent } from "../server/src/ai/intent";
import { planProjectTasks } from "../server/src/ai/loop";
import { prepareDomainBrief } from "../server/src/ai/domainKnowledge";

/**
 * Dev-only audit: run intent + domain brief + planner with dryRun, without
 * editing project source. This is for inspecting what the agent understood.
 */
const root = "/tmp/cie-chess-audit";
const instruction = process.argv[2] || "Kedili bir satranç oyunu yap";
const language = process.argv[3] || "tr";

await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(root, { recursive: true });
await fs.writeFile(path.join(root, "README.md"), "# Chess audit\n\nEmpty test project.\n");

const analysis = await analyzeProject(root);
await saveAnalysis(analysis);
try {
  const analyzed = await analyzeIntent(analysis.id, instruction, { language });
  const brief = await prepareDomainBrief(root, instruction, { write: false });
  const queue = await planProjectTasks(analysis.id, instruction, {
    language,
    intent: analyzed.intent,
    dryRun: true,
  });
  const report = {
    instruction,
    language,
    projectRoot: root,
    intent: analyzed.intent,
    domainFacts: brief?.facts ?? null,
    tasks: queue.tasks.map((task) => ({
      title: task.title,
      detail: task.detail,
      acceptance: task.acceptance,
      action: task.action,
      surface: task.surface,
      effort: task.effort,
    })),
    planMeta: queue.planMeta,
  };
  await fs.writeFile(
    "/tmp/cie-chess-audit-report.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await removeAnalysis(analysis.id);
}
