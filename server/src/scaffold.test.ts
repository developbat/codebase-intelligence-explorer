import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "./analyzer";
import { listProjectTemplates, scaffoldProject } from "./scaffold";

async function tempParent(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cie-scaffold-"));
}

test("lists the built-in project templates", () => {
  const templates = listProjectTemplates();
  assert.deepEqual(
    templates.map((item) => item.id),
    [
      "static",
      "react-vite",
      "node-express",
      "python-fastapi",
      "php-web",
      "blank",
      "canvas-game",
      "pwa-mobile",
      "expo-mobile",
    ],
  );
  for (const template of templates) {
    assert.ok(template.name);
    assert.ok(template.description);
    assert.ok(template.files.length > 0);
  }
});

test("scaffolds a static project and analyzes it", async () => {
  const parent = await tempParent();
  try {
    const result = await scaffoldProject({ parentPath: parent, name: "static-demo", template: "static" });
    assert.equal(result.rootPath, path.join(await fs.realpath(parent), "static-demo"));
    assert.deepEqual(result.filesCreated, ["index.html", "styles.css", "app.js", "README.md", ".gitignore"]);
    const html = await fs.readFile(path.join(result.rootPath, "index.html"), "utf8");
    assert.match(html, /<title>static-demo<\/title>/);
    assert.match(html, /app\.js/);

    const analysis = await analyzeProject(result.rootPath);
    assert.equal(analysis.projectName, "static-demo");
    assert.ok(analysis.files.some((file) => file.path === "index.html"));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("scaffolds React and Express templates with valid package manifests", async () => {
  const parent = await tempParent();
  try {
    const react = await scaffoldProject({ parentPath: parent, name: "react-demo", template: "react-vite" });
    const reactPackage = JSON.parse(await fs.readFile(path.join(react.rootPath, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    assert.equal(reactPackage.scripts.dev, "vite");
    assert.ok(reactPackage.scripts.typecheck);
    assert.ok(reactPackage.dependencies.react);
    assert.ok(await fs.readFile(path.join(react.rootPath, "src", "App.tsx"), "utf8"));

    const express = await scaffoldProject({ parentPath: parent, name: "api-demo", template: "node-express" });
    const expressPackage = JSON.parse(await fs.readFile(path.join(express.rootPath, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    assert.equal(expressPackage.scripts.dev, "tsx watch src/index.ts");
    assert.ok(expressPackage.dependencies.express);
    const index = await fs.readFile(path.join(express.rootPath, "src", "index.ts"), "utf8");
    assert.match(index, /healthRouter/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("scaffolds Python, PHP and blank projects", async () => {
  const parent = await tempParent();
  try {
    const python = await scaffoldProject({ parentPath: parent, name: "py-demo", template: "python-fastapi" });
    assert.match(await fs.readFile(path.join(python.rootPath, "app", "main.py"), "utf8"), /FastAPI/);
    assert.match(await fs.readFile(path.join(python.rootPath, "tests", "test_health.py"), "utf8"), /TestClient/);

    const php = await scaffoldProject({ parentPath: parent, name: "php-demo", template: "php-web" });
    assert.match(await fs.readFile(path.join(php.rootPath, "public", "index.php"), "utf8"), /Greeter/);
    assert.deepEqual(php.warnings, ["PHP files are shown as source; no PHP runtime preview is started."]);

    const blank = await scaffoldProject({ parentPath: parent, name: "blank-demo", template: "blank" });
    assert.deepEqual(blank.filesCreated, ["README.md", ".gitignore"]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("rejects unsafe names, missing parents and non-empty targets", async () => {
  const parent = await tempParent();
  try {
    await assert.rejects(
      () => scaffoldProject({ parentPath: parent, name: "../escape", template: "blank" }),
      /project name/i,
    );
    await assert.rejects(
      () => scaffoldProject({ parentPath: parent, name: ".hidden", template: "blank" }),
      /project name/i,
    );
    await assert.rejects(
      () => scaffoldProject({ parentPath: path.join(parent, "missing"), name: "app", template: "blank" }),
      /parent folder/i,
    );

    const target = path.join(parent, "taken");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep.txt"), "do not touch");
    await assert.rejects(
      () => scaffoldProject({ parentPath: parent, name: "taken", template: "static" }),
      /not empty/i,
    );
    assert.equal(await fs.readFile(path.join(target, "keep.txt"), "utf8"), "do not touch");

    await assert.rejects(
      () => scaffoldProject({ parentPath: parent, name: "unknown-demo", template: "does-not-exist" as never }),
      /unknown project template/i,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("scaffolds canvas game, PWA and Expo mobile templates", async () => {
  const parent = await tempParent();
  try {
    const game = await scaffoldProject({ parentPath: parent, name: "game-demo", template: "canvas-game" });
    assert.match(await fs.readFile(path.join(game.rootPath, "game.js"), "utf8"), /requestAnimationFrame|pointerdown/);
    assert.match(await fs.readFile(path.join(game.rootPath, "index.html"), "utf8"), /id="game"/);

    const pwa = await scaffoldProject({ parentPath: parent, name: "pwa-demo", template: "pwa-mobile" });
    const manifest = JSON.parse(await fs.readFile(path.join(pwa.rootPath, "manifest.webmanifest"), "utf8")) as {
      display: string;
      icons: { src: string }[];
    };
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.icons[0]?.src, "icons/icon.svg");
    assert.match(await fs.readFile(path.join(pwa.rootPath, "sw.js"), "utf8"), /caches/);

    const expo = await scaffoldProject({ parentPath: parent, name: "expo-demo", template: "expo-mobile" });
    const expoPackage = JSON.parse(await fs.readFile(path.join(expo.rootPath, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    assert.equal(expoPackage.scripts.web, "expo start --web");
    assert.ok(expoPackage.dependencies.expo);
    assert.match(await fs.readFile(path.join(expo.rootPath, "App.tsx"), "utf8"), /SafeAreaView/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
