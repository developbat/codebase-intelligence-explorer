import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult, DuplicationBlock, DuplicationReport } from "../../shared/types";

interface WindowOccurrence {
  path: string;
  startLine: number;
  endLine: number;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isTrivial(line: string): boolean {
  if (!line) return true;
  if (/^[{}()[\];,]+$/.test(line)) return true;
  if (/^(\/\/|#|\/\*|\*|<!--)/.test(line)) return true;
  if (/^(import|from|export\s+\{|const\s+\w+\s*=\s*require\()/.test(line)) return false;
  return line.length < 3;
}

export async function scanDuplications(
  analysis: AnalysisResult,
  options: { windowLines?: number; maxBlocks?: number } = {},
): Promise<DuplicationReport> {
  const windowLines = Math.max(4, Math.min(20, options.windowLines ?? 6));
  const maxBlocks = Math.max(10, Math.min(200, options.maxBlocks ?? 80));
  const groups = new Map<string, { sample: string; occurrences: WindowOccurrence[] }>();
  let filesScanned = 0;

  const files = analysis.files.slice(0, 600);
  const queue = [...files];
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      if (file.bytes > 600_000 || /\.min\./i.test(file.path)) continue;
      let content: string;
      try {
        // eslint-disable-next-line no-await-in-loop
        content = await fs.readFile(path.join(analysis.rootPath, file.path), "utf8");
      } catch {
        continue;
      }
      filesScanned += 1;
      const meaningful = content
        .split("\n")
        .map((text, index) => ({ text: normalizeLine(text), line: index + 1 }))
        .filter((entry) => !isTrivial(entry.text));
      if (meaningful.length < windowLines) continue;

      for (let index = 0; index + windowLines <= meaningful.length; index += 1) {
        const window = meaningful.slice(index, index + windowLines);
        const normalized = window.map((entry) => entry.text).join("\n");
        const hash = crypto.createHash("sha1").update(normalized).digest("hex");
        const startLine = window[0].line;
        const endLine = window[window.length - 1].line;
        let group = groups.get(hash);
        if (!group) {
          group = { sample: window.slice(0, 3).map((entry) => entry.text).join("\n"), occurrences: [] };
          groups.set(hash, group);
        }
        const last = group.occurrences[group.occurrences.length - 1];
        if (last && last.path === file.path && startLine <= last.endLine) continue;
        group.occurrences.push({ path: file.path, startLine, endLine });
      }
    }
  });
  await Promise.all(workers);

  const blocks: DuplicationBlock[] = [...groups.entries()]
    .filter(([, group]) => {
      const uniqueFiles = new Set(group.occurrences.map((entry) => entry.path));
      return group.occurrences.length >= 2 || uniqueFiles.size >= 2;
    })
    .map(([hash, group]) => ({
      hash,
      lines: windowLines,
      sample: group.sample,
      occurrences: group.occurrences,
    }))
    .filter((block) => block.occurrences.length >= 2)
    .sort((a, b) => b.occurrences.length - a.occurrences.length)
    .slice(0, maxBlocks);

  const duplicatedLines = blocks.reduce(
    (total, block) => total + (block.occurrences.length - 1) * block.lines,
    0,
  );

  return {
    filesScanned,
    windowLines,
    blocks,
    duplicatedLines,
    generatedAt: new Date().toISOString(),
  };
}
