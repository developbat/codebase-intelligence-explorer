import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { answerGeneralChat } from "./ai/service";

export interface PatchSummary {
  files: string[];
  identifiers: string[];
  added: number;
  removed: number;
}

export function parsePatchForEval(patch: string): PatchSummary {
  const files = [
    ...new Set(
      [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm)].map((match) => match[2]),
    ),
  ];
  const identifiers = new Set<string>();
  for (const match of patch.matchAll(
    /^[+-]\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|def|interface|type)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    identifiers.add(match[1]);
  }
  for (const match of patch.matchAll(
    /^@@[^\n]*?\b(?:function|class|def)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    identifiers.add(match[1]);
  }
  for (const match of patch.matchAll(/^[+-]\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    if (!["if", "for", "while", "switch", "catch", "return", "function"].includes(match[1])) {
      identifiers.add(match[1]);
    }
  }
  const added = (patch.match(/^\+[^+]/gm) ?? []).length;
  const removed = (patch.match(/^-[^-]/gm) ?? []).length;
  return { files, identifiers: [...identifiers].slice(0, 30), added, removed };
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFileCitation(answer: string, files: string[]): boolean {
  if (/\b[\w./-]+\.(?:[cm]?[jt]sx?|vue|svelte|html?|css|scss|php|py|go|rs|java|kt|cs|rb|swift|json|toml|ya?ml):\d+/.test(answer)) {
    return true;
  }
  return files.some((file) => {
    const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `${base}[\\s\\S]{0,160}(?:\\d+\\s*[-–]\\s*\\d+|satır\\s*\\d+|satirlar\\s*\\d+|line\\s*\\d+|lines\\s*\\d+)`,
      "i",
    ).test(answer);
  });
}

function looksLikeToolJson(value: string): boolean {
  return (
    /^\s*\{[\s\S]{0,400}"(?:action|tool|args|name)"\s*:/i.test(value.trim()) ||
    /<tool_call>|<\/?function|DSML/i.test(value)
  );
}

async function main(): Promise<void> {
  const patchFile = argValue("--patch");
  const repo = argValue("--repo") ?? process.env.CIE_EVAL_REPO;
  const ref = argValue("--ref") ?? process.env.CIE_EVAL_REF ?? "HEAD~1";
  let patch = "";
  if (patchFile) {
    patch = await fs.readFile(path.resolve(patchFile), "utf8");
  } else if (repo) {
    patch = execFileSync(
      "git",
      ["-C", path.resolve(repo), "diff", ref, "--no-color", "--unified=3"],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
  } else {
    throw new Error("Pass --patch <file> or --repo <path> [--ref <git-ref>].");
  }
  if (!patch.trim()) throw new Error("The patch is empty.");
  const summary = parsePatchForEval(patch);
  if (summary.files.length === 0) throw new Error("No changed files found in the patch.");

  const instruction =
    "Bu patch ne değiştirdi? Değişen dosyayı ve davranışı kısa ve teknik olarak açıkla. " +
    "Yalnızca patch'teki kanıtlara dayan; dosya/satır referansı ver.";
  const result = await answerGeneralChat(
    process.env.CIE_EVAL_PROJECT_ID ?? "chat-patch-eval",
    instruction,
    {
      provider: process.env.CIE_EVAL_PROVIDER as never,
      model: process.env.CIE_EVAL_MODEL,
      language: "tr",
      promptId: "chat.answer",
      workState: `Patch:\n${patch.slice(0, 24_000)}`,
    },
  );
  const answer = result.summary.trim();
  const lower = answer.toLowerCase();
  const failures: string[] = [];
  const fileHit = summary.files.some((file) => {
    const base = path.basename(file).toLowerCase();
    return lower.includes(file.toLowerCase()) || lower.includes(base);
  });
  if (!fileHit) failures.push(`no changed file mentioned (${summary.files.join(", ")})`);
  if (summary.identifiers.length > 0) {
    const identifierHit = summary.identifiers.some((id) => lower.includes(id.toLowerCase()));
    if (!identifierHit) failures.push(`no changed identifier mentioned (${summary.identifiers.slice(0, 8).join(", ")})`);
  }
  if (!hasFileCitation(answer, summary.files)) {
    failures.push("no file:line or file+line-range citation");
  }
  if (looksLikeToolJson(answer)) failures.push("answer looks like a tool-call JSON");
  if (/i (?:edited|changed|wrote)|değiştirdim|düzenledim/i.test(answer)) {
    failures.push("chat claims it edited files");
  }

  const pass = failures.length === 0;
  console.log(`Patch: ${summary.files.join(", ")} · +${summary.added}/-${summary.removed}`);
  console.log(`Identifiers: ${summary.identifiers.slice(0, 12).join(", ") || "none"}`);
  console.log(`${pass ? "PASS" : "FAIL"} [patch] · ${result.provider}/${result.model} · ${result.tokenUsage?.totalTokens ?? 0} tokens`);
  for (const failure of failures) console.log(`   - ${failure}`);
  if (!pass) console.log(`   answer: ${answer.replace(/\s+/g, " ").slice(0, 500)}`);

  const reportsDir = path.resolve("fixtures", "agent-eval", "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `patch-${stamp}.json`);
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        repo,
        ref,
        patchFile,
        summary,
        pass,
        failures,
        answer,
        model: `${result.provider}/${result.model}`,
        tokens: result.tokenUsage?.totalTokens,
      },
      null,
      2,
    ),
  );
  console.log(`Report: ${reportPath}`);
  process.exitCode = pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
