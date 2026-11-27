import path from "node:path";

export interface BatchRenameItem {
  from: string;
  to: string;
  status: "ready" | "skip" | "conflict" | "invalid";
  reason?: string;
}

export interface BatchRenamePlan {
  scanned: number;
  matched: number;
  items: BatchRenameItem[];
  ready: number;
  conflicts: number;
}

export function planBatchRename(
  paths: string[],
  options: {
    path?: string;
    find: string;
    replace: string;
    useRegex?: boolean;
    max?: number;
  },
): BatchRenamePlan {
  const find = options.find;
  if (!find) throw new Error("The find text is required.");
  const scope = options.path?.replace(/^\/+/, "").replace(/\/+$/, "");
  const max = Math.max(1, Math.min(500, Number(options.max) || 200));
  let matcher: RegExp;
  try {
    matcher = options.useRegex
      ? new RegExp(find, "g")
      : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  } catch {
    throw new Error("The rename pattern is not a valid regular expression.");
  }

  const existing = new Set(paths);
  const targets = new Set<string>();
  const items: BatchRenameItem[] = [];
  let scanned = 0;
  let matched = 0;

  for (const filePath of paths) {
    if (items.length >= max) break;
    if (scope && filePath !== scope && !filePath.startsWith(`${scope}/`)) continue;
    scanned += 1;
    const base = path.posix.basename(filePath);
    const directory = path.posix.dirname(filePath);
    const nextBase = options.useRegex
      ? base.replace(matcher, options.replace)
      : base.split(find).join(options.replace);
    matcher.lastIndex = 0;
    if (nextBase === base) continue;
    matched += 1;
    const to = directory === "." ? nextBase : `${directory}/${nextBase}`;
    if (!nextBase || nextBase.includes("/") || nextBase.includes("\\")) {
      items.push({ from: filePath, to, status: "invalid", reason: "The new name is invalid." });
      continue;
    }
    if (to === filePath) {
      items.push({ from: filePath, to, status: "skip", reason: "The name is unchanged." });
      continue;
    }
    if (existing.has(to) || targets.has(to)) {
      items.push({ from: filePath, to, status: "conflict", reason: "The target already exists." });
      continue;
    }
    targets.add(to);
    items.push({ from: filePath, to, status: "ready" });
  }

  return {
    scanned,
    matched,
    items,
    ready: items.filter((item) => item.status === "ready").length,
    conflicts: items.filter((item) => item.status === "conflict" || item.status === "invalid").length,
  };
}
