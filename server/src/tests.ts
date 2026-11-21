import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnalysisResult,
  TestDiscovery,
  TestFailure,
  TestRunResult,
  TestSummary,
} from "../../shared/types";
import { runProjectCommand } from "./editor";
import { detectProjectProfile, testFilesFor as testFilesForPaths } from "./projectProfile";

export async function discoverTests(analysis: AnalysisResult): Promise<TestDiscovery> {
  const testFiles = testFilesForPaths(analysis.files);
  const profile = await detectProjectProfile(
    analysis.rootPath,
    analysis.files.map((file) => ({ path: file.path })),
    analysis.frameworks ?? [],
  );
  return {
    framework: profile.testFramework,
    commands: profile.testCommands,
    testFiles: testFiles.slice(0, 80),
    testFileCount: testFiles.length,
    hasTests: profile.hasTests,
  };
}

function emptySummary(): TestSummary {
  return { passed: 0, failed: 0, skipped: 0, total: 0 };
}

function relativePath(analysis: AnalysisResult, value: string): string | undefined {
  if (!value) return undefined;
  let cleaned = value.replace(/\\/g, "/").replace(/^file:\/\//, "");
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // keep the raw path when it is not valid percent-encoding
  }
  if (!path.isAbsolute(cleaned)) return cleaned.replace(/^\.\//, "");
  const relative = path.relative(analysis.rootPath, cleaned).replace(/\\/g, "/");
  return relative.startsWith("..") ? undefined : relative;
}

function fileLineFromLocation(
  analysis: AnalysisResult,
  raw: string,
): { file?: string; line?: number } {
  let value = raw.trim();
  if (value.startsWith("file://")) value = value.slice(7);
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep the raw location
  }
  const withColumn = value.match(/^(.*):(\d+):(\d+)$/);
  if (withColumn) {
    return { file: relativePath(analysis, withColumn[1]), line: Number(withColumn[2]) };
  }
  const withLine = value.match(/^(.*):(\d+)$/);
  if (!withLine) return { file: relativePath(analysis, value) };
  return { file: relativePath(analysis, withLine[1]), line: Number(withLine[2]) };
}

function fileLineFromText(analysis: AnalysisResult, text: string): { file?: string; line?: number } {
  const match = text.match(
    /([A-Za-z0-9_./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|php|py|go|rs|java|kt|kts|cs|rb|swift|scala|dart|exs|ex|c|cc|cpp|cxx|h|hpp)):(\d+)(?::\d+)?/,
  );
  if (!match) return {};
  return { file: relativePath(analysis, match[1]), line: Number(match[2]) };
}

function parseJestVitest(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  let parsed = false;

  const vitest = output.match(
    /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s*\((\d+)\)/i,
  );
  const jest = output.match(
    /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed,\s*)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+total/i,
  );
  if (vitest) {
    summary.failed = Number(vitest[1] ?? 0);
    summary.passed = Number(vitest[2] ?? 0);
    summary.skipped = Number(vitest[3] ?? 0);
    summary.total = Number(vitest[4] ?? 0);
    parsed = true;
  } else if (jest) {
    summary.failed = Number(jest[1] ?? 0);
    summary.passed = Number(jest[2] ?? 0);
    summary.skipped = Number(jest[3] ?? 0);
    summary.total = Number(jest[4] ?? 0);
    parsed = true;
  }

  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const failLine = line.match(/^(?:FAIL|×|✕)\s+(.+)$/);
    const bullet = line.match(/^●\s+(.+)$/);
    if (!failLine && !bullet) continue;
    const name = (failLine?.[1] ?? bullet?.[1] ?? "").replace(/\s+/g, " ").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const nearby = lines.slice(index + 1, index + 8).join("\n");
    const location = fileLineFromText(analysis, `${line}\n${nearby}`);
    const pathOnly = (failLine?.[1] ?? "").match(/([A-Za-z0-9_./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|php|py))/);
    failures.push({
      name: name.length > 180 ? `${name.slice(0, 177)}…` : name,
      file: location.file ?? (pathOnly ? relativePath(analysis, pathOnly[1]) : undefined),
      line: location.line,
      message: nearby.split("\n").map((value) => value.trim()).find(Boolean)?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed };
}

function parsePytest(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  let parsed = false;
  const failed = output.match(/(\d+)\s+failed/i);
  const passed = output.match(/(\d+)\s+passed/i);
  const skipped = output.match(/(\d+)\s+skipped/i);
  if (failed || passed) {
    summary.failed = Number(failed?.[1] ?? 0);
    summary.passed = Number(passed?.[1] ?? 0);
    summary.skipped = Number(skipped?.[1] ?? 0);
    summary.total = summary.failed + summary.passed + summary.skipped;
    parsed = true;
  }

  const failures: TestFailure[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^(?:FAILED|ERROR)\s+([^:\s]+)(?:::([^\s]+))?(?:\s+-\s+(.*))?$/);
    if (!match) continue;
    const file = relativePath(analysis, match[1]);
    failures.push({
      name: match[2] ?? match[1],
      file,
      message: match[3]?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed };
}

function parsePhpUnit(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  let parsed = false;

  const ok = output.match(/OK\s*\((\d+)\s+tests?,\s*(\d+)\s+assertions?\)/i);
  if (ok) {
    summary.passed = Number(ok[1]);
    summary.total = summary.passed;
    parsed = true;
  } else {
    const tests = output.match(/Tests:\s*(\d+)(?:,\s*Assertions:\s*\d+)?(?:,\s*Errors:\s*(\d+))?(?:,\s*Failures:\s*(\d+))?/i);
    if (tests) {
      summary.total = Number(tests[1]);
      summary.failed = Number(tests[2] ?? 0) + Number(tests[3] ?? 0);
      summary.passed = Math.max(0, summary.total - summary.failed);
      parsed = true;
    }
  }

  const failures: TestFailure[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const match = line.match(/^\d+\)\s+(.+)$/);
    if (!match) continue;
    const nearby = lines.slice(index + 1, index + 6).join("\n");
    const location = fileLineFromText(analysis, nearby);
    failures.push({
      name: match[1].slice(0, 180),
      file: location.file,
      line: location.line,
      message: nearby.split("\n").map((value) => value.trim()).find(Boolean)?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed };
}

function parseGo(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const failures: TestFailure[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const status = line.match(/^---\s+(PASS|FAIL|SKIP):\s+(.+?)(?:\s+\(\d+(?:\.\d+)?s\))?$/);
    if (status) {
      if (status[1] === "PASS") summary.passed += 1;
      else if (status[1] === "SKIP") summary.skipped += 1;
      else {
        summary.failed += 1;
        const nearby = lines.slice(index + 1, index + 8).join("\n");
        const location = fileLineFromText(analysis, `${line}\n${nearby}`);
        failures.push({
          name: status[2].slice(0, 180),
          file: location.file,
          line: location.line,
          message: nearby.split("\n").map((value) => value.trim()).find(Boolean)?.slice(0, 240),
        });
      }
    }
  }
  if (summary.passed + summary.failed + summary.skipped === 0) {
    const ok = (output.match(/^ok\s+/gm) ?? []).length;
    const fail = (output.match(/^FAIL\s+/gm) ?? []).length;
    if (ok + fail > 0) {
      summary.passed = ok;
      summary.failed = fail;
      summary.total = ok + fail;
      return { summary, failures, parsed: true };
    }
    return { summary, failures, parsed: false };
  }
  summary.total = summary.passed + summary.failed + summary.skipped;
  return { summary, failures, parsed: true };
}

function parseCargo(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const failures: TestFailure[] = [];
  let parsed = false;
  const resultPattern = /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g;
  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(output))) {
    summary.passed += Number(match[1]);
    summary.failed += Number(match[2]);
    summary.skipped += Number(match[3]);
    parsed = true;
  }
  const lines = output.split("\n");
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const failed = line.match(/^test\s+(.+?)\s+\.\.\.\s+FAILED$/);
    const panic = line.match(/^----\s+(.+?)\s+stdout\s+----$/);
    const name = failed?.[1] ?? panic?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const nearby = lines.slice(index + 1, index + 12).join("\n");
    const location = fileLineFromText(analysis, nearby);
    failures.push({
      name: name.slice(0, 180),
      file: location.file,
      line: location.line,
      message: nearby.split("\n").map((value) => value.trim()).find(Boolean)?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  summary.total = summary.passed + summary.failed + summary.skipped;
  return { summary, failures, parsed: parsed || failures.length > 0 };
}

function parseDotnet(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(
    /(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/i,
  );
  if (!match) return { summary, failures: [], parsed: false };
  summary.failed = Number(match[1]);
  summary.passed = Number(match[2]);
  summary.skipped = Number(match[3]);
  summary.total = Number(match[4]);

  const failures: TestFailure[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const failed = line.match(/^Failed\s+(.+?)(?:\s+\[\d+\s*ms\])?$/);
    if (!failed) continue;
    const nearby = lines.slice(index + 1, index + 10).join("\n");
    const location = fileLineFromText(analysis, nearby);
    failures.push({
      name: failed[1].slice(0, 180),
      file: location.file,
      line: location.line,
      message: nearby.split("\n").map((value) => value.trim()).find(Boolean)?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed: true };
}

function parseJvm(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  let parsed = false;
  const pattern = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output))) {
    summary.total += Number(match[1]);
    summary.failed += Number(match[2]) + Number(match[3]);
    summary.skipped += Number(match[4]);
    parsed = true;
  }
  if (parsed) summary.passed = Math.max(0, summary.total - summary.failed - summary.skipped);

  const failures: TestFailure[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const failed = line.match(/^(.+?)\s+>\s+(.+?)\s+FAILED$/);
    if (!failed) continue;
    const nearby = lines.slice(index + 1, index + 10).join("\n");
    const location = fileLineFromText(analysis, nearby);
    failures.push({
      name: `${failed[1]} > ${failed[2]}`.slice(0, 180),
      file: location.file,
      line: location.line,
      message: nearby.split("\n").map((value) => value.trim()).find(Boolean)?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed };
}

function parseRspec(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(/(\d+)\s+examples?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+pending)?/i);
  if (!match) return { summary, failures: [], parsed: false };
  summary.total = Number(match[1]);
  summary.failed = Number(match[2]);
  summary.skipped = Number(match[3] ?? 0);
  summary.passed = Math.max(0, summary.total - summary.failed - summary.skipped);

  const failures: TestFailure[] = [];
  const pattern = /^rspec\s+(\.\/[^:]+):(\d+)\s+#\s+(.+)$/gm;
  let failure: RegExpExecArray | null;
  while ((failure = pattern.exec(output))) {
    failures.push({
      name: failure[3].slice(0, 180),
      file: relativePath(analysis, failure[1]),
      line: Number(failure[2]),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed: true };
}

function parseMinitest(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(
    /(\d+)\s+runs?,\s*\d+\s+assertions?,\s*(\d+)\s+failures?,\s*(\d+)\s+errors?,\s*(\d+)\s+skips?/i,
  );
  if (!match) return { summary, failures: [], parsed: false };
  summary.total = Number(match[1]);
  summary.failed = Number(match[2]) + Number(match[3]);
  summary.skipped = Number(match[4]);
  summary.passed = Math.max(0, summary.total - summary.failed - summary.skipped);

  const failures: TestFailure[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!/^(Failure|Error):$/.test(line)) continue;
    const nearby = lines.slice(index + 1, index + 8).join("\n");
    const nameLine = lines.slice(index + 1, index + 4).map((value) => value.trim()).find(Boolean) ?? "Minitest failure";
    const location = fileLineFromText(analysis, nearby);
    failures.push({
      name: nameLine.slice(0, 180),
      file: location.file,
      line: location.line,
      message: nearby.split("\n").map((value) => value.trim()).find(Boolean)?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed: true };
}

function parseSwift(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  let parsed = false;
  const pattern = /Executed\s+(\d+)\s+tests?,\s+with\s+(\d+)\s+failures?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output))) {
    summary.total += Number(match[1]);
    summary.failed += Number(match[2]);
    parsed = true;
  }
  if (parsed) summary.passed = Math.max(0, summary.total - summary.failed);

  const failures: TestFailure[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const failed = line.match(/^Test Case '(.+?)' failed/);
    if (!failed) continue;
    const nearby = lines.slice(index + 1, index + 8).join("\n");
    const location = fileLineFromText(analysis, nearby);
    failures.push({
      name: failed[1].slice(0, 180),
      file: location.file,
      line: location.line,
      message: nearby.split("\n").map((value) => value.trim()).find(Boolean)?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed };
}

function parseElixir(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(/(\d+)\s+tests?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+skipped)?/i);
  if (!match) return { summary, failures: [], parsed: false };
  summary.total = Number(match[1]);
  summary.failed = Number(match[2]);
  summary.skipped = Number(match[3] ?? 0);
  summary.passed = Math.max(0, summary.total - summary.failed - summary.skipped);

  const failures: TestFailure[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const failed = line.match(/^\d+\)\s+test\s+(.+)$/);
    if (!failed) continue;
    const nearby = lines.slice(index + 1, index + 8).join("\n");
    const location = fileLineFromText(analysis, nearby);
    failures.push({
      name: failed[1].slice(0, 180),
      file: location.file,
      line: location.line,
      message: nearby.split("\n").map((value) => value.trim()).find(Boolean)?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed: true };
}

function parseDart(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const matches = [...output.matchAll(/\+(\d+)(?:\s+-(\d+))?/g)];
  if (matches.length === 0) return { summary, failures: [], parsed: false };
  const last = matches[matches.length - 1];
  summary.passed = Number(last[1] ?? 0);
  summary.failed = Number(last[2] ?? 0);
  summary.total = summary.passed + summary.failed;

  const failures: TestFailure[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(?:\d+:\d+\s+)?\+\d+\s+-\d+:\s+(.+?)\s*\[E\]/);
    if (!match) continue;
    failures.push({ name: match[1].slice(0, 180) });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed: true };
}

function parseCTest(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(/(\d+)%\s+tests passed,\s*(\d+)\s+tests failed out of\s*(\d+)/i)
    ?? output.match(/(\d+)\s+tests passed,\s*(\d+)\s+tests failed out of\s*(\d+)/i);
  if (!match) return { summary, failures: [], parsed: false };
  const percent = output.includes("%") ? Number(match[1]) : 0;
  const failed = Number(match[2]);
  const total = Number(match[3]);
  summary.total = total;
  summary.failed = failed;
  summary.passed = Math.max(0, total - failed);

  const failures: TestFailure[] = [];
  for (const line of output.split("\n")) {
    const failedLine = line.match(/^\s*\d+\s+-\s+(.+?)\s+\(Failed\)/);
    if (!failedLine) continue;
    failures.push({ name: failedLine[1].slice(0, 180) });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed: true };
}

function parseSbt(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(/Tests:\s*succeeded\s*(\d+),\s*failed\s*(\d+)/i);
  if (!match) return { summary, failures: [], parsed: false };
  summary.passed = Number(match[1]);
  summary.failed = Number(match[2]);
  summary.total = summary.passed + summary.failed;
  return { summary, failures: [], parsed: true };
}

function parseTap(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const failures: TestFailure[] = [];
  for (const line of output.split("\n")) {
    const ok = line.match(/^ok\s+\d+\s*(?:-\s*(.*))?$/i);
    const notOk = line.match(/^not ok\s+\d+\s*(?:-\s*(.*))?$/i);
    if (ok) {
      if (/#\s*skip/i.test(line)) summary.skipped += 1;
      else summary.passed += 1;
    } else if (notOk) {
      summary.failed += 1;
      failures.push({ name: (notOk[1] ?? "TAP failure").trim().slice(0, 180) });
    }
  }
  summary.total = summary.passed + summary.failed + summary.skipped;
  return { summary, failures, parsed: summary.total > 0 };
}

function parseNodeTest(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const passed = output.match(/^# pass (\d+)$/m);
  const failed = output.match(/^# fail (\d+)$/m);
  const skipped = output.match(/^# skipped (\d+)$/m);
  const todo = output.match(/^# todo (\d+)$/m);
  if (!passed && !failed) return { summary, failures: [], parsed: false };
  summary.passed = Number(passed?.[1] ?? 0);
  summary.failed = Number(failed?.[1] ?? 0);
  summary.skipped = Number(skipped?.[1] ?? 0) + Number(todo?.[1] ?? 0);
  summary.total = summary.passed + summary.failed + summary.skipped;
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^not ok \d+ - (.+)$/);
    if (!match) continue;
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const nearby = lines.slice(index + 1, index + 16).join("\n");
    const location = nearby.match(/location:\s*'([^']+)'/);
    const located = location ? fileLineFromLocation(analysis, location[1]) : {};
    failures.push({
      name: name.slice(0, 180),
      file: located.file,
      line: located.line,
      message: nearby.match(/error:\s*'([^']+)'/)?.[1]?.slice(0, 240),
    });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed: true };
}

function parseHspec(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(/(\d+)\s+examples?,\s*(\d+)\s+failures?/i);
  if (!match) return { summary, failures: [], parsed: false };
  const examples = Number(match[1]);
  summary.failed = Number(match[2]);
  summary.passed = Math.max(0, examples - summary.failed);
  summary.total = examples;
  const failures: TestFailure[] = [];
  for (const line of output.split("\n")) {
    const failure = line.match(/^\s*\d+\)\s+(.+)$/);
    if (failure) failures.push({ name: failure[1].trim().slice(0, 180) });
    if (failures.length >= 60) break;
  }
  return { summary, failures, parsed: true };
}

function parseJulia(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(/Test Summary:[\s\S]{0,800}?\|\s*(\d+)\s+(\d+)\s+(\d+)/);
  if (!match) return { summary, failures: [], parsed: false };
  summary.passed = Number(match[1]);
  summary.failed = Number(match[2]);
  summary.total = Number(match[3]);
  summary.skipped = Math.max(0, summary.total - summary.passed - summary.failed);
  return { summary, failures: [], parsed: true };
}

function parseTestthat(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(/\[\s*FAIL\s+(\d+)\s*\|\s*WARN\s+\d+\s*\|\s*SKIP\s+(\d+)\s*\|\s*PASS\s+(\d+)\s*\]/i);
  if (!match) return { summary, failures: [], parsed: false };
  summary.failed = Number(match[1]);
  summary.skipped = Number(match[2]);
  summary.passed = Number(match[3]);
  summary.total = summary.failed + summary.skipped + summary.passed;
  return { summary, failures: [], parsed: true };
}

function parsePester(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(/Tests Passed:\s*(\d+),\s*Failed:\s*(\d+),\s*Skipped:\s*(\d+)/i);
  if (!match) return { summary, failures: [], parsed: false };
  summary.passed = Number(match[1]);
  summary.failed = Number(match[2]);
  summary.skipped = Number(match[3]);
  summary.total = summary.passed + summary.failed + summary.skipped;
  return { summary, failures: [], parsed: true };
}

function parseClojure(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const match = output.match(/Ran\s+(\d+)\s+tests?\s+containing\s+\d+\s+assertions?\.\s*(\d+)\s+failures?,\s*(\d+)\s+errors?/i);
  if (!match) return { summary, failures: [], parsed: false };
  summary.total = Number(match[1]);
  summary.failed = Number(match[2]) + Number(match[3]);
  summary.passed = Math.max(0, summary.total - summary.failed);
  return { summary, failures: [], parsed: true };
}

function parseGeneric(analysis: AnalysisResult, output: string): {
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
} {
  const summary = emptySummary();
  const failed = output.match(/(\d+)\s+failed/i);
  const passed = output.match(/(\d+)\s+passed/i);
  if (!failed && !passed) return { summary, failures: [], parsed: false };
  summary.failed = Number(failed?.[1] ?? 0);
  summary.passed = Number(passed?.[1] ?? 0);
  summary.total = summary.failed + summary.passed;
  return { summary, failures: [], parsed: true };
}

function selectParser(
  analysis: AnalysisResult,
  framework: string | undefined,
  command: string,
  output: string,
): ReturnType<typeof parseGeneric> {
  const lower = command.toLowerCase();
  if (/^# pass \d+$/m.test(output)) return parseNodeTest(analysis, output);
  if (framework === "Pytest" || /\bpytest\b/.test(lower)) return parsePytest(analysis, output);
  if (framework === "PHPUnit" || framework === "Laravel" || /phpunit|artisan test/i.test(lower)) return parsePhpUnit(analysis, output);
  if (framework === "Jest" || framework === "Vitest" || /jest|vitest|npm test/i.test(lower)) return parseJestVitest(analysis, output);
  if (framework === "Go test" || /\bgo test\b/.test(lower)) return parseGo(analysis, output);
  if (framework === "Cargo test" || /\bcargo test\b/.test(lower)) return parseCargo(analysis, output);
  if (framework === "dotnet test" || /\bdotnet test\b/.test(lower)) return parseDotnet(analysis, output);
  if (framework === "Maven" || framework === "Gradle" || /\b(?:mvn|gradle)\b/.test(lower)) return parseJvm(analysis, output);
  if (framework === "RSpec" || /\brspec\b/.test(lower)) return parseRspec(analysis, output);
  if (framework === "Minitest" || /\brake test\b/.test(lower)) return parseMinitest(analysis, output);
  if (framework === "Swift test" || /\bswift test\b/.test(lower)) return parseSwift(analysis, output);
  if (framework === "ExUnit" || /\bmix test\b/.test(lower)) return parseElixir(analysis, output);
  if (framework === "Dart test" || framework === "Flutter test" || /\b(?:dart|flutter) test\b/.test(lower)) return parseDart(analysis, output);
  if (framework === "CTest" || /\bctest\b/.test(lower)) return parseCTest(analysis, output);
  if (framework === "sbt" || /\bsbt test\b/.test(lower)) return parseSbt(analysis, output);
  if (framework === "prove" || framework === "Busted" || framework === "Bats" || /\b(?:prove|busted|bats)\b/.test(lower)) return parseTap(analysis, output);
  if (framework === "Cabal test" || framework === "Stack test" || framework === "Crystal spec" || /\b(?:cabal test|stack test|crystal spec)\b/.test(lower)) return parseHspec(analysis, output);
  if (framework === "Julia Test" || /pkg\.test\(\)/.test(lower)) return parseJulia(analysis, output);
  if (framework === "testthat" || /testthat/.test(lower)) return parseTestthat(analysis, output);
  if (framework === "Pester" || /invoke-pester/i.test(lower)) return parsePester(analysis, output);
  if (framework === "Clojure test" || /\b(?:lein test|clojure -x:test)\b/.test(lower)) return parseClojure(analysis, output);
  return parseGeneric(analysis, output);
}

export async function runTests(
  analysis: AnalysisResult,
  requestedCommand?: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  } = {},
): Promise<TestRunResult> {
  const discovery = await discoverTests(analysis);
  const framework = discovery.framework;
  const command = requestedCommand?.trim() || discovery.commands[0];
  if (!command) {
    throw new Error(
      "No test command was detected. Add a test framework or define a test script in package.json.",
    );
  }
  const timeoutMs = Math.max(30_000, Math.min(30 * 60_000, options.timeoutMs ?? 5 * 60_000));
  const result = await runProjectCommand(analysis.rootPath, command, undefined, {
    signal: options.signal,
    timeoutMs,
    onStdout: (chunk) => options.onOutput?.(chunk, "stdout"),
    onStderr: (chunk) => options.onOutput?.(chunk, "stderr"),
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const parsed = selectParser(analysis, framework, command, output);

  return {
    ...result,
    framework,
    summary: parsed.summary,
    failures: parsed.failures,
    parsed: parsed.parsed,
  };
}
