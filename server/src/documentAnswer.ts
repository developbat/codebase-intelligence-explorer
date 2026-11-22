import type { DocumentOperation, IntentAnalysis } from "../../shared/intent";
import { documentStats, readDocument } from "./documentTools";

export interface DocumentOperationAnswer {
  summary: string;
  files: number;
  total: number;
}

function attachmentPaths(instruction: string): string[] {
  return [...instruction.matchAll(/(?:Ek dosya|Attached file|Ekli dosya):\s*([^\s]+)/gi)]
    .map((match) => match[1])
    .slice(0, 5);
}

/**
 * Deterministic extraction for checklist questions. The intent analyst decides
 * the operation; this function returns the exact items without a model scan.
 */
export async function answerDocumentOperation(
  rootPath: string,
  instruction: string,
  intent: IntentAnalysis,
): Promise<DocumentOperationAnswer | null> {
  const operation: DocumentOperation = intent.documentOperation;
  if (operation === "none") return null;
  const paths = attachmentPaths(instruction);
  if (paths.length === 0) return null;

  const sections: string[] = [];
  let total = 0;
  let files = 0;
  for (const pathValue of paths) {
    let document;
    try {
      // eslint-disable-next-line no-await-in-loop
      document = await readDocument(rootPath, pathValue, { maxChars: 80_000, ocr: false });
    } catch {
      sections.push(`${pathValue}: could not be read.`);
      continue;
    }
    const stats = document.stats ?? documentStats(document.text);
    files += 1;
    if (operation === "count_unchecked" || operation === "count_checked") {
      const count = operation === "count_unchecked" ? stats.uncheckedBoxes : stats.checkedBoxes;
      total += count;
      sections.push(
        `${document.path}: ${count} ${operation === "count_unchecked" ? "unchecked" : "checked"} item(s).`,
      );
      continue;
    }
    const items = operation === "list_unchecked" ? stats.uncheckedItems : stats.checkedItems;
    total += operation === "list_unchecked" ? stats.uncheckedBoxes : stats.checkedBoxes;
    sections.push(
      [
        `${document.path}: ${
          operation === "list_unchecked" ? stats.uncheckedBoxes : stats.checkedBoxes
        } ${operation === "list_unchecked" ? "unchecked" : "checked"} item(s).`,
        ...items.map(
          (item, index) => `${index + 1}. line ${item.line} — ${item.text}`,
        ),
      ].join("\n"),
    );
  }

  if (sections.length === 0) return null;
  const heading =
    operation === "count_unchecked"
      ? `Unchecked items: ${total}`
      : operation === "count_checked"
        ? `Checked items: ${total}`
        : operation === "list_unchecked"
          ? `Unchecked items: ${total}`
          : `Checked items: ${total}`;
  return { summary: [heading, "", ...sections].join("\n"), files, total };
}
