import path from "node:path";
import { analyzeProject } from "./analyzer";
import { saveAnalysis } from "./store";

async function main() {
  const input = process.argv[2] ?? process.cwd();
  const root = path.resolve(input);
  console.log(`Analyzing: ${root}`);
  const result = await analyzeProject(root);
  await saveAnalysis(result);
  const { stats } = result;
  console.log("");
  console.log(`  Project     : ${result.projectName}`);
  console.log(`  Files       : ${stats.files}`);
  console.log(`  Folders     : ${stats.folders}`);
  console.log(`  Lines       : ${stats.lines.toLocaleString("en-US")}`);
  console.log(`  Symbols     : ${stats.symbols} (${stats.functions} functions/methods, ${stats.classes} classes)`);
  console.log(`  Architecture: ${stats.routes} routes, ${stats.databases} database objects, ${stats.events} events`);
  console.log(`  Frameworks  : ${(result.frameworks ?? []).join(", ") || "none detected"}`);
  console.log(
    `  Git         : ${
      result.git?.available
        ? `${result.git.branch} @ ${result.git.head?.slice(0, 8)}${result.git.dirty ? " (dirty)" : ""}`
        : "not available"
    }`,
  );
  console.log(`  Graph       : ${stats.nodes} node, ${stats.edges} edge`);
  console.log(`  Evidence    : ${stats.confirmedEdges} confirmed, ${stats.inferredEdges} inferred, ${stats.unresolvedEdges} unresolved`);
  console.log(`  Duration    : ${stats.durationMs} ms`);
  if (result.warnings.length > 0) {
    console.log("");
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
  }
  console.log("");
  console.log(`  Cache       : ~/.codebase-intelligence-explorer/projects/${result.id}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
