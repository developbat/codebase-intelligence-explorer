import fs from "node:fs/promises";
import path from "node:path";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    throw new Error("Usage: npm run reset:agent -- /absolute/path/to/project");
  }
  const projectRoot = path.resolve(input.startsWith("~") ? path.join(process.env.HOME ?? "", input.slice(1)) : input);
  const agentDir = path.join(projectRoot, ".cie", "agent");
  const exists = await fs.stat(agentDir).then(() => true).catch(() => false);
  if (!exists) {
    console.log(`No agent memory found at ${agentDir}`);
    console.log("The next agent run will create a fresh .cie/agent folder.");
    return;
  }
  const archiveDir = path.join(projectRoot, ".cie", `agent-archive-${stamp()}`);
  await fs.rename(agentDir, archiveDir);
  console.log(`Archived agent memory:\n  from ${agentDir}\n  to   ${archiveDir}`);
  console.log("Project code is untouched. The next agent run starts with fresh memory.");
  console.log("Browser chat tabs are local; use New chat or clear cie:studio-chat:* keys to hide old conversations.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
