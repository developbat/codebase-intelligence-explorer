import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import {
  applyMappingsToContent,
  extractEntities,
  resolveEntityKind,
  resolveWorkBrief,
} from "./extractors";

async function fixture(): Promise<{ root: string; analysis: AnalysisResult }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-extract-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, "index.html"),
    [
      '<input id="task-input" name="title" type="text" placeholder="Yeni görev" />',
      '<select id="priority" name="priority"></select>',
      '<button id="add-task" type="submit">Ekle</button>',
      '<a href="/help">Yardım</a>',
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "styles.css"),
    [":root { --cyan: #22d3ee; --bg: #050810; }", ".btn { background: rgba(34, 211, 238, 0.18); }"].join(
      "\n",
    ),
  );
  await fs.writeFile(
    path.join(root, "src/config.ts"),
    [
      'const key = process.env.API_KEY;',
      'app.get("/orders", handler);',
      'import { x } from "./x";',
      "// TODO: add validation",
      'const remote = http.get("https://example.com/api");',
      'const value = map.get("project");',
      'const fireButton = document.createElement("button");',
      'fireButton.id = "fire-button";',
      'fireButton.textContent = "🔥";',
      'const checkbox = document.createElement("input");',
      'checkbox.type = "checkbox";',
      'checkbox.setAttribute("aria-label", "Seç");',
    ].join("\n"),
  );
  await fs.mkdir(path.join(root, "app"), { recursive: true });
  await fs.writeFile(
    path.join(root, "app/main.py"),
    [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "app.include_router(",
      "    todo_router,",
      '    prefix="/v1/todos",',
      ")",
    ].join("\n"),
  );
  await fs.writeFile(path.join(root, "README.md"), "# Proje\n\n[Docs](docs/guide.md)\n");
  await fs.writeFile(path.join(root, "assets/icon.png"), "png");
  await fs.writeFile(path.join(root, "assets/logo.svg"), "<svg></svg>");
  const files = [
    { path: "index.html", bytes: 200, loc: 4 },
    { path: "styles.css", bytes: 100, loc: 2 },
    { path: "src/config.ts", bytes: 100, loc: 4 },
    { path: "app/main.py", bytes: 100, loc: 6 },
    { path: "README.md", bytes: 30, loc: 3 },
    { path: "assets/icon.png", bytes: 3, loc: 1 },
  ];
  const analysis = {
    id: "extract-test",
    rootPath: root,
    createdAt: new Date().toISOString(),
    files,
    symbols: [
      { name: "run", kind: "function", qualifiedName: "run", filePath: "src/config.ts", startLine: 1 },
      { name: "Service", kind: "class", qualifiedName: "Service", filePath: "src/config.ts", startLine: 8 },
    ],
  } as unknown as AnalysisResult;
  return { root, analysis };
}

test("resolves extraction kinds and work briefs in Turkish and English", () => {
  assert.equal(resolveEntityKind("tüm renkleri listele"), "color");
  assert.equal(resolveEntityKind("buton renklerini değiştir"), "color");
  assert.equal(resolveEntityKind("list all inputs"), "input");
  assert.equal(resolveEntityKind("md dosyalarını listele"), "document");
  assert.equal(resolveEntityKind("markdown başlıklarını listele"), "markdown");
  assert.equal(resolveEntityKind("assetleri göster"), "asset");
  assert.equal(resolveEntityKind("bana uygulamadaki buton listesini getir"), "button");
  assert.deepEqual(resolveWorkBrief("bana uygulamadaki buton listesini getir"), {
    mode: "extract",
    kind: "button",
  });
  assert.equal(resolveEntityKind("List every API route with its HTTP method and path"), "route");
  assert.equal(resolveEntityKind("list all methods in OrderService"), "function");
  assert.deepEqual(resolveWorkBrief("list all inputs"), { mode: "extract", kind: "input" });
  assert.deepEqual(resolveWorkBrief("buton renklerini değiştir"), { mode: "change", kind: "color" });
  assert.equal(resolveWorkBrief("where is OrderService?"), null);
  assert.equal(resolveWorkBrief("where are the colors defined?"), null);
  assert.deepEqual(resolveWorkBrief("which colors are defined?"), { mode: "extract", kind: "color" });
  assert.deepEqual(resolveWorkBrief("renkleri listele ve değiştir"), {
    mode: "change",
    kind: "color",
  });
  assert.deepEqual(resolveWorkBrief("renkleri değiştirme, sadece listele"), {
    mode: "extract",
    kind: "color",
  });
  assert.deepEqual(
    resolveWorkBrief(
      "Tüm #22d3ee renk kullanımlarını #ff5c8a ile değiştir. Başka hiçbir rengi değiştirme.",
    ),
    { mode: "change", kind: "color" },
  );
  assert.deepEqual(resolveWorkBrief("don't change colors, list them"), {
    mode: "extract",
    kind: "color",
  });
  assert.deepEqual(resolveWorkBrief("Change colors but do not change the background"), {
    mode: "change",
    kind: "color",
  });
  assert.deepEqual(resolveWorkBrief("butonları listele ve eksik olanı ekle"), {
    mode: "change",
    kind: "button",
  });
});

test("extracts UI, code, env, route, asset and markdown entities", async () => {
  const { root, analysis } = await fixture();
  try {
    const input = await extractEntities(analysis, { kind: "input", scope: "index.html" });
    assert.equal(input.total, 2);
    assert.ok(input.items.some((item) => item.values.name === "task-input"));
    const button = await extractEntities(analysis, { kind: "button", scope: "index.html" });
    assert.equal(button.total, 1);
    assert.ok(button.items[0].values.text.includes("Ekle"));
    const dynamicButton = await extractEntities(analysis, {
      kind: "button",
      scope: "src/config.ts",
    });
    assert.ok(dynamicButton.items.some((item) => item.values.name === "fire-button"));
    const dynamicInput = await extractEntities(analysis, {
      kind: "input",
      scope: "src/config.ts",
    });
    assert.ok(
      dynamicInput.items.some(
        (item) => item.values.name === "Seç" && item.values.type === "checkbox",
      ),
    );
    const link = await extractEntities(analysis, { kind: "link", scope: "index.html" });
    assert.equal(link.total, 1);
    assert.equal(link.items[0].values.href, "/help");
    const color = await extractEntities(analysis, { kind: "color", scope: "styles.css" });
    assert.equal(color.unique, 3);
    assert.ok(color.markdown.includes("#22d3ee"));
    const functions = await extractEntities(analysis, { kind: "function", scope: "src/config.ts" });
    assert.equal(functions.total, 1);
    assert.ok(functions.items[0].values.name === "run");
    const classes = await extractEntities(analysis, { kind: "class", scope: "src/config.ts" });
    assert.equal(classes.total, 1);
    const env = await extractEntities(analysis, { kind: "env", scope: "src/config.ts" });
    assert.ok(env.items.some((item) => item.values.name === "API_KEY"));
    const route = await extractEntities(analysis, { kind: "route", scope: "src/config.ts" });
    assert.equal(route.total, 1);
    assert.ok(route.items.some((item) => item.values.path === "/orders" && item.values.method === "GET"));
    assert.ok(route.items.every((item) => item.values.path.startsWith("/")));
    const imported = await extractEntities(analysis, { kind: "import", scope: "src/config.ts" });
    assert.ok(imported.items.some((item) => item.values.value === "./x"));
    const pyRoutes = await extractEntities(analysis, { kind: "route", scope: "app/main.py" });
    assert.ok(pyRoutes.items.some((item) => item.values.method === "PREFIX" && item.values.path === "/v1/todos"));
    const text = await extractEntities(analysis, { kind: "text", query: "Ekle" });
    assert.ok(text.items.some((item) => item.values.text.includes("Ekle")));
    const selector = await extractEntities(analysis, { kind: "selector", scope: "styles.css" });
    assert.ok(selector.items.some((item) => item.values.selector === ":root"));
    assert.ok(selector.items.some((item) => item.values.selector === ".btn"));
    assert.ok(selector.items.every((item) => item.values.type === "css"));
    const asset = await extractEntities(analysis, { kind: "asset" });
    assert.equal(asset.total, 2);
    assert.ok(asset.items.some((item) => item.values.file === "assets/icon.png"));
    assert.ok(asset.items.some((item) => item.values.file === "assets/logo.svg"));
    const markdown = await extractEntities(analysis, { kind: "markdown", scope: "README.md" });
    assert.ok(markdown.items.some((item) => item.values.text.includes("Proje")));
    assert.ok(markdown.items.some((item) => item.values.text.includes("Docs")));
    const documents = await extractEntities(analysis, { kind: "document" });
    assert.ok(documents.items.some((item) => item.values.file === "README.md"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("applies mapped color and text changes without prefix corruption", () => {
  const color = applyMappingsToContent(
    ".a { color: #fff; background: #ffffff; border-color: #FFF; }",
    "color",
    [
      ["#fff", "#000"],
      ["#ffffff", "#111111"],
    ],
  );
  assert.equal(color.content, ".a { color: #000; background: #111111; border-color: #000; }");
  assert.equal(color.count, 3);

  const text = applyMappingsToContent(
    "<button>Ekle</button>\n<button>Ekle</button>",
    "text",
    [["Ekle", "Kaydet"]],
  );
  assert.equal(text.content, "<button>Kaydet</button>\n<button>Kaydet</button>");
  assert.equal(text.replacements[0]?.count, 2);

  const untouched = applyMappingsToContent("#ffffffff", "color", [["#fff", "#000"]]);
  assert.equal(untouched.content, "#ffffffff");
  assert.equal(untouched.count, 0);

  const swapped = applyMappingsToContent(
    "<b>#fff</b><i>#000</i>",
    "color",
    [
      ["#fff", "#000"],
      ["#000", "#fff"],
    ],
  );
  assert.equal(swapped.content, "<b>#000</b><i>#fff</i>");
  assert.equal(swapped.count, 2);

  const textSwapped = applyMappingsToContent("A B A", "text", [
    ["A", "B"],
    ["B", "A"],
  ]);
  assert.equal(textSwapped.content, "B A B");
});
