import fs from "node:fs/promises";
import path from "node:path";
import { loadAnalysis } from "./store";
import { extractEntities, type EntityKind, type EntityResult } from "./extractors";

interface ExpectedItem {
  file?: string;
  line?: number | string;
  name?: string;
  text?: string;
  textIncludes?: string;
  value?: string;
  method?: string;
  path?: string;
  selector?: string;
  color?: string;
  href?: string;
}

interface ExtractionCase {
  id: string;
  projectId: string;
  kind: EntityKind;
  scope?: string | string[];
  query?: string;
  limit?: number;
  exactTotal?: number;
  minTotal?: number;
  maxTotal?: number;
  exactUnique?: number;
  minUnique?: number;
  expectUnique?: boolean;
  truncated?: boolean;
  items: ExpectedItem[];
}

interface ExtractionFixture {
  cases: ExtractionCase[];
}

function valueOf(item: EntityResult["items"][number], key: string): string {
  if (key === "file") return item.file;
  if (key === "line") return String(item.line);
  return String(item.values[key] ?? "");
}

function matchItem(item: EntityResult["items"][number], expected: ExpectedItem): boolean {
  for (const [key, raw] of Object.entries(expected)) {
    if (raw === undefined) continue;
    if (key.endsWith("Includes")) {
      const field = key.slice(0, -"Includes".length);
      if (!valueOf(item, field).toLowerCase().includes(String(raw).toLowerCase())) {
        return false;
      }
      continue;
    }
    if (valueOf(item, key).toLowerCase() !== String(raw).toLowerCase()) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const fixtureDir = path.resolve("fixtures", "agent-eval");
  const fixture = JSON.parse(
    await fs.readFile(path.join(fixtureDir, "extraction.json"), "utf8"),
  ) as ExtractionFixture;
  const results: {
    id: string;
    projectId: string;
    kind: EntityKind;
    pass: boolean;
    failures: string[];
    total?: number;
    unique?: number;
    truncated?: boolean;
    durationMs?: number;
  }[] = [];

  for (const testCase of fixture.cases) {
    const started = Date.now();
    const failures: string[] = [];
    let total: number | undefined;
    let unique: number | undefined;
    let truncated: boolean | undefined;
    try {
      const analysis = await loadAnalysis(testCase.projectId);
      const result = await extractEntities(analysis, {
        kind: testCase.kind,
        scope: testCase.scope,
        query: testCase.query,
        limit: testCase.limit ?? 2_000,
      });
      total = result.total;
      unique = result.unique;
      truncated = result.truncated;
      if (testCase.exactTotal !== undefined && result.total !== testCase.exactTotal) {
        failures.push(`total ${result.total}, expected ${testCase.exactTotal}`);
      }
      if (testCase.minTotal !== undefined && result.total < testCase.minTotal) {
        failures.push(`total ${result.total}, expected at least ${testCase.minTotal}`);
      }
      if (testCase.maxTotal !== undefined && result.total > testCase.maxTotal) {
        failures.push(`total ${result.total}, expected at most ${testCase.maxTotal}`);
      }
      if (testCase.exactUnique !== undefined && result.unique !== testCase.exactUnique) {
        failures.push(`unique ${result.unique}, expected ${testCase.exactUnique}`);
      }
      if (testCase.minUnique !== undefined && result.unique < testCase.minUnique) {
        failures.push(`unique ${result.unique}, expected at least ${testCase.minUnique}`);
      }
      if (testCase.expectUnique === true && result.unique !== result.total) {
        failures.push(`unique ${result.unique} != total ${result.total}`);
      }
      if (testCase.truncated !== undefined && result.truncated !== testCase.truncated) {
        failures.push(`truncated ${result.truncated}, expected ${testCase.truncated}`);
      }
      for (const expected of testCase.items ?? []) {
        if (!result.items.some((item) => matchItem(item, expected))) {
          failures.push(`missing item ${JSON.stringify(expected)}`);
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "extraction failed");
    }
    results.push({
      id: testCase.id,
      projectId: testCase.projectId,
      kind: testCase.kind,
      pass: failures.length === 0,
      failures,
      total,
      unique,
      truncated,
      durationMs: Date.now() - started,
    });
  }

  const passed = results.filter((result) => result.pass).length;
  for (const result of results) {
    const counts =
      result.total === undefined
        ? ""
        : ` · ${result.total}/${result.unique}${result.truncated ? " truncated" : ""}`;
    console.log(
      `${result.pass ? "PASS" : "FAIL"} [extract] ${result.id}${counts} · ${result.durationMs} ms`,
    );
    for (const failure of result.failures) console.log(`   - ${failure}`);
  }
  console.log(`\n${passed}/${results.length} extraction checks passed`);

  const reportsDir = path.join(fixtureDir, "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `extraction-${stamp}.json`);
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      { createdAt: new Date().toISOString(), passed, total: results.length, results },
      null,
      2,
    ),
  );
  console.log(`Report: ${reportPath}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
