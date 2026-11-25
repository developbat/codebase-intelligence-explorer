import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AiAgentStep } from "../../shared/ai";
import { analyzeProject } from "./analyzer";
import {
  buildFeatureQueries,
  featurePreflightHints,
  isInteractiveUiCheck,
} from "./ai/loop";

function step(overrides: Partial<AiAgentStep>): AiAgentStep {
  return {
    index: 1,
    action: "browser_check",
    args: {},
    observation: "",
    ok: true,
    durationMs: 10,
    ...overrides,
  };
}

test("buildFeatureQueries extracts feature terms from a multi-item goal", () => {
  const queries = buildFeatureQueries(
    "Satışları CSV dışında JSON olarak da dışa aktar.\nEn yüksek satış yapılan günü göster.",
  );
  assert.ok(queries.some((query) => /json/i.test(query)));
  assert.ok(queries.some((query) => /satış|satis|sales/i.test(query)));
  assert.ok(queries.length <= 8);
});

test("featurePreflightHints finds an existing download button in source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-preflight-"));
  try {
    await fs.writeFile(
      path.join(root, "app.py"),
      [
        "import streamlit as st",
        "st.download_button('JSON indir', data='[]', file_name='sales.json', mime='application/json')",
        "",
      ].join("\n"),
    );
    const analysis = await analyzeProject(root);
    const hints = await featurePreflightHints(analysis, "Satışları JSON olarak dışa aktar");
    assert.ok(
      hints.some((hint) => /app\.py/.test(hint) && /json/i.test(hint)),
      `hints: ${hints.join(" | ")}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isInteractiveUiCheck requires both an interaction and an assertion", () => {
  assert.equal(
    isInteractiveUiCheck(
      step({
        args: {
          steps: [
            { action: "click", selector: "#start" },
            { action: "expectText", selector: "#status", text: "Started" },
          ],
        },
        observation: "Browser check passed.",
      }),
    ),
    true,
  );
  assert.equal(
    isInteractiveUiCheck(
      step({
        args: { steps: [{ action: "expectVisible", selector: "canvas" }] },
        observation: "Browser check passed.",
      }),
    ),
    false,
  );
  assert.equal(
    isInteractiveUiCheck(
      step({
        args: { steps: [{ action: "click", selector: "#start" }] },
        observation: "Browser check passed.",
      }),
    ),
    false,
  );
  assert.equal(
    isInteractiveUiCheck(
      step({
        action: "game_check",
        args: {
          steps: [
            { action: "eval", value: "click key", expectText: "playing" },
          ],
        },
        observation: "Game check passed.",
      }),
    ),
    true,
  );
  assert.equal(
    isInteractiveUiCheck(
      step({
        ok: false,
        args: {
          steps: [
            { action: "click", selector: "#start" },
            { action: "expectText", selector: "#status", text: "Started" },
          ],
        },
      }),
    ),
    false,
  );
});
