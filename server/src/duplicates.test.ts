import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateFiles, formatBytes, summarizeStorage } from "./duplicates";
import type { FileRecord } from "../../shared/types";

const files: FileRecord[] = [
  { id: "1", path: "a.txt", language: "text", bytes: 100, loc: 1, hash: "same", imports: [] },
  { id: "2", path: "nested/a-copy.txt", language: "text", bytes: 100, loc: 1, hash: "same", imports: [] },
  { id: "3", path: "b.txt", language: "text", bytes: 200, loc: 1, hash: "other", imports: [] },
  { id: "4", path: "assets/logo.png", language: "image", bytes: 1000, loc: 0, hash: "logo", imports: [] },
];

test("findDuplicateFiles groups identical hashes and sizes", () => {
  const report = findDuplicateFiles(files);
  assert.equal(report.scanned, 4);
  assert.equal(report.groups.length, 1);
  assert.deepEqual(report.groups[0].paths, ["a.txt", "nested/a-copy.txt"]);
  assert.equal(report.duplicateFiles, 1);
  assert.equal(report.wastedBytes, 100);
});

test("findDuplicateFiles respects scope and minimum size", () => {
  assert.equal(findDuplicateFiles(files, { path: "assets" }).groups.length, 0);
  assert.equal(findDuplicateFiles(files, { minBytes: 200 }).groups.length, 0);
});

test("summarizeStorage groups by top-level folder", () => {
  const report = summarizeStorage(files, { top: 2 });
  assert.equal(report.totalBytes, 1400);
  assert.equal(report.folders[0].path, "assets");
  assert.equal(report.folders.some((folder) => folder.path === "(root)"), true);
  assert.equal(formatBytes(1400), "1.4 KB");
});
