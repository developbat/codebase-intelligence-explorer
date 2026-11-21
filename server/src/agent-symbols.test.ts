import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { queryProjectSymbols } from "./ai/service";

const analysis = {
  symbols: [
    { name: "UserService", qualifiedName: "UserService", kind: "class", filePath: "src/services/user.service.ts", startLine: 4 },
    { name: "getUser", qualifiedName: "UserService.getUser", kind: "method", filePath: "src/services/user.service.ts", startLine: 8 },
    { name: "getUser", qualifiedName: "UserController.getUser", kind: "method", filePath: "src/controllers/user.controller.ts", startLine: 7 },
    { name: "main", qualifiedName: "main", kind: "function", filePath: "main.go", startLine: 12 },
  ],
} as unknown as AnalysisResult;

test("find_symbols searches names, qualified names and files with kind/limit filters", () => {
  const users = queryProjectSymbols(analysis, "user", undefined, 20);
  assert.equal(users.length, 3);
  assert.ok(users.every((symbol) => symbol.qualifiedName.toLowerCase().includes("user")));

  const methods = queryProjectSymbols(analysis, "getuser", "method", 20);
  assert.equal(methods.length, 2);
  assert.ok(methods.every((symbol) => symbol.kind === "method"));

  const limited = queryProjectSymbols(analysis, "user", "class", 1);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].qualifiedName, "UserService");

  const byFile = queryProjectSymbols(analysis, "main.go", undefined, 20);
  assert.equal(byFile.length, 1);
  assert.equal(byFile[0].name, "main");
});
