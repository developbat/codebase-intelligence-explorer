import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectBrainConstraint } from "../../shared/projectBrain";
import { auditProjectConstraints } from "./ai/constraintRules";

function constraint(text: string, kind: ProjectBrainConstraint["kind"] = "behavior"): ProjectBrainConstraint {
  return { id: text, text, kind };
}

test("only-path constraints reject changes outside the allowed file", () => {
  const constraints = [
    constraint("Only change docs/members/testcrud/api/functions.php", "path"),
  ];
  assert.equal(
    auditProjectConstraints({
      constraints,
      changedFiles: ["docs/members/testcrud/api/functions.php"],
      summary: "",
    }).ok,
    true,
  );
  const violation = auditProjectConstraints({
    constraints,
    changedFiles: ["docs/members/testcrud/api/functions.php", "app/main.dart"],
    summary: "",
  });
  assert.equal(violation.ok, false);
  assert.match(violation.violations.join(" "), /allows only/i);
});

test("server-only and do-not-touch-app constraints reject UI changes", () => {
  const files = ["web/src/App.tsx", "server/api.php", "app/main.dart"];
  assert.equal(
    auditProjectConstraints({
      constraints: [constraint("Server-side only")],
      changedFiles: ["server/api.php"],
      summary: "",
      files,
    }).ok,
    true,
  );
  const web = auditProjectConstraints({
    constraints: [constraint("Server-side only")],
    changedFiles: ["web/src/App.tsx"],
    summary: "",
    files,
  });
  assert.equal(web.ok, false);
  const app = auditProjectConstraints({
    constraints: [constraint("Uygulama koduna dokunma")],
    changedFiles: ["app/main.dart"],
    summary: "",
    files,
  });
  assert.equal(app.ok, false);
});

test("secret leaks are rejected and no-secret constraints are enforced", () => {
  const leaked = auditProjectConstraints({
    constraints: [],
    changedFiles: ["server/api.php"],
    summary: "Done. apiKey: sk-abcdefghijklmnop",
  });
  assert.equal(leaked.ok, false);
  assert.match(leaked.violations.join(" "), /credential/i);

  const noSecret = auditProjectConstraints({
    constraints: [constraint("Parola yanıtta görünmesin", "security")],
    changedFiles: ["server/api.php"],
    summary: "Parola: hunter2 olarak güncellendi.",
  });
  assert.equal(noSecret.ok, false);
});

test("a forbidden file clause is not turned into an only-allow rule", () => {
  const result = auditProjectConstraints({
    constraints: [
      constraint("Uygulama koduna (app.js) dokunma; sadece oyun dosyalarını düzelt.", "path"),
    ],
    changedFiles: ["game.js"],
    summary: "",
    files: ["app.js", "game.js", "index.html"],
  });
  assert.equal(result.ok, true);
  assert.equal(
    auditProjectConstraints({
      constraints: [
        constraint("Uygulama koduna (app.js) dokunma; sadece oyun dosyalarını düzelt.", "path"),
      ],
      changedFiles: ["app.js"],
      summary: "",
      files: ["app.js", "game.js"],
    }).ok,
    false,
  );
});

test("task-scoped constraints do not leak into another goal", () => {
  const constraints = [
    {
      ...constraint("Only change a.php", "path"),
      scope: "task" as const,
      goal: "Goal A",
    },
  ];
  assert.equal(
    auditProjectConstraints({
      constraints,
      changedFiles: ["b.php"],
      summary: "",
      goal: "Goal A",
    }).ok,
    false,
  );
  assert.equal(
    auditProjectConstraints({
      constraints,
      changedFiles: ["b.php"],
      summary: "",
      goal: "Goal B",
    }).ok,
    true,
  );
});

test("vague constraints warn instead of inventing a path violation", () => {
  const result = auditProjectConstraints({
    constraints: [constraint("Server-side only")],
    changedFiles: ["src/util.ts"],
    summary: "",
    files: ["src/util.ts"],
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.length > 0);
});
