import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGraphic } from "./graphics";

test("creates bar, flow and illustration graphics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-graphics-"));
  try {
    const bar = await createGraphic(root, {
      path: "assets/report",
      kind: "bar",
      title: "Weekly progress",
      data: [
        { label: "Mon", value: 4 },
        { label: "Tue", value: 7 },
      ],
    });
    assert.equal(bar.path, "assets/report.svg");
    const barSvg = await fs.readFile(path.join(root, bar.path), "utf8");
    assert.match(barSvg, /Weekly progress/);
    assert.match(barSvg, /Mon/);
    assert.match(barSvg, /<rect/);

    const flow = await createGraphic(root, {
      path: "assets/flow.svg",
      kind: "flow",
      title: "Delivery flow",
      steps: ["Plan", "Build", "Verify"],
    });
    assert.match(await fs.readFile(path.join(root, flow.path), "utf8"), /marker-end/);

    const art = await createGraphic(root, {
      path: "assets/cover",
      kind: "illustration",
      title: "Release",
      colors: ["#5eead4", "#6ea8fe"],
    });
    assert.match(await fs.readFile(path.join(root, art.path), "utf8"), /<circle|<rect/);

    await assert.rejects(
      () => createGraphic(root, { path: "../escape.svg", kind: "bar", data: [{ label: "A", value: 1 }] }),
      /outside the project/i,
    );
    await assert.rejects(
      () => createGraphic(root, { path: "assets/empty.svg", kind: "pie", data: [] }),
      /non-empty data/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
