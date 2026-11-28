import fs from "node:fs/promises";
import path from "node:path";
import { isWithin } from "./scanner";
import { planPythonEnvironment } from "./pythonRuntime";
import { EXTRA_TEMPLATES } from "./extraTemplates";
import type {
  ProjectTemplate,
  ScaffoldProjectRequest,
  ScaffoldProjectResult,
} from "../../shared/types";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface TemplateFile {
  path: string;
  content: string;
}

interface TemplateDefinition extends ProjectTemplate {
  build: (name: string) => TemplateFile[];
}

function packageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 64) || "app";
}

function readme(name: string, title: string, lines: string[]): string {
  return [`# ${name}`, "", title, "", ...lines, ""].join("\n");
}

const GITIGNORE = `node_modules/
dist/
build/
.env
.env.*
!.env.example
.DS_Store
*.log
__pycache__/
.venv/
.pytest_cache/
`;

const STATIC_TEMPLATE: TemplateDefinition = {
  id: "static",
  name: "Static HTML",
  description: "Minimal HTML, CSS and JavaScript skeleton with no build step or demo content.",
  language: "HTML / CSS / JavaScript",
  framework: "Vanilla",
  files: ["index.html", "styles.css", "app.js", "README.md", ".gitignore"],
  suggestedCommands: ["npx serve .", "python3 -m http.server 8000"],
  build: (name) => [
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main id="app"></main>
    <script src="./app.js"></script>
  </body>
</html>
`,
    },
    {
      path: "styles.css",
      content: `:root {
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #080b10;
  color: #e6edf7;
}

* {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  margin: 0;
}
`,
    },
    {
      path: "app.js",
      content: `// Add the app code here.
`,
    },
    {
      path: "README.md",
      content: readme(name, "A dependency-free static website.", [
        "## Run",
        "",
        "```bash",
        "npx serve .",
        "```",
        "",
        "Or use Python:",
        "",
        "```bash",
        "python3 -m http.server 8000",
        "```",
      ]),
    },
    { path: ".gitignore", content: GITIGNORE },
  ],
};

const REACT_TEMPLATE: TemplateDefinition = {
  id: "react-vite",
  name: "React + Vite",
  description: "React 18, TypeScript, Vite and a strict tsconfig.",
  language: "TypeScript / React",
  framework: "React + Vite",
  files: [
    "package.json",
    "index.html",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.node.json",
    "src/main.tsx",
    "src/App.tsx",
    "src/styles.css",
    "src/vite-env.d.ts",
    "README.md",
    ".gitignore",
  ],
  suggestedCommands: ["npm install", "npm run dev", "npm run typecheck"],
  build: (name) => [
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: packageName(name),
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            dev: "vite",
            build: "tsc -b && vite build",
            preview: "vite preview",
            typecheck: "tsc --noEmit",
          },
          dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: {
            "@types/react": "^18.3.12",
            "@types/react-dom": "^18.3.1",
            "@vitejs/plugin-react": "^4.3.4",
            typescript: "^5.6.3",
            vite: "^5.4.11",
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: "vite.config.ts",
      content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
    },
    {
      path: "tsconfig.json",
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2020",
            useDefineForClassFields: true,
            lib: ["ES2020", "DOM", "DOM.Iterable"],
            module: "ESNext",
            skipLibCheck: true,
            moduleResolution: "Bundler",
            allowImportingTsExtensions: true,
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
            jsx: "react-jsx",
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noFallthroughCasesInSwitch: true,
          },
          include: ["src"],
          references: [{ path: "./tsconfig.node.json" }],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "tsconfig.node.json",
      content: `${JSON.stringify(
        {
          compilerOptions: {
            composite: true,
            skipLibCheck: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            allowSyntheticDefaultImports: true,
          },
          include: ["vite.config.ts"],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "src/main.tsx",
      content: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    },
    {
      path: "src/App.tsx",
      content: `export function App() {
  return (
    <main>
      <h1>${name}</h1>
    </main>
  );
}
`,
    },
    {
      path: "src/styles.css",
      content: `:root {
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #080b10;
  color: #e6edf7;
}

* {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at top, #14243b, #080b10 55%);
}

.card {
  width: min(560px, calc(100vw - 32px));
  padding: 32px;
  border: 1px solid #233246;
  border-radius: 18px;
  background: rgba(13, 20, 31, 0.9);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}

.eyebrow {
  margin: 0 0 8px;
  color: #5eead4;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 12px;
  font-size: clamp(28px, 6vw, 44px);
}

p {
  color: #9fb3cc;
  line-height: 1.6;
}

button {
  margin-top: 8px;
  padding: 10px 16px;
  border: 1px solid #2b5f8f;
  border-radius: 8px;
  background: #153352;
  color: #d7ecff;
  font: inherit;
  cursor: pointer;
}

button:hover {
  background: #1b4168;
}
`,
    },
    {
      path: "src/vite-env.d.ts",
      content: `/// <reference types="vite/client" />\n`,
    },
    {
      path: "README.md",
      content: readme(name, "A React + TypeScript application built with Vite.", [
        "## Run",
        "",
        "```bash",
        "npm install",
        "npm run dev",
        "```",
        "",
        "## Verify",
        "",
        "```bash",
        "npm run typecheck",
        "npm run build",
        "```",
      ]),
    },
    { path: ".gitignore", content: GITIGNORE },
  ],
};

const EXPRESS_TEMPLATE: TemplateDefinition = {
  id: "node-express",
  name: "Node + Express",
  description: "TypeScript, Express and a small health/API route with tsx dev reload.",
  language: "TypeScript",
  framework: "Express",
  files: [
    "package.json",
    "tsconfig.json",
    "src/index.ts",
    "src/routes/health.ts",
    "README.md",
    ".gitignore",
  ],
  suggestedCommands: ["npm install", "npm run dev", "npm run typecheck"],
  build: (name) => [
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: packageName(name),
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            dev: "tsx watch src/index.ts",
            build: "tsc",
            start: "node dist/index.js",
            typecheck: "tsc --noEmit",
          },
          dependencies: { cors: "^2.8.5", express: "^4.21.1" },
          devDependencies: {
            "@types/cors": "^2.8.17",
            "@types/express": "^4.17.21",
            "@types/node": "^18.19.0",
            tsx: "^4.19.2",
            typescript: "^5.6.3",
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "tsconfig.json",
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            rootDir: "src",
            outDir: "dist",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src"],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "src/routes/health.ts",
      content: `import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({ ok: true, service: "${name}", time: new Date().toISOString() });
});
`,
    },
    {
      path: "src/index.ts",
      content: `import cors from "cors";
import express from "express";
import { healthRouter } from "./routes/health.js";

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());
app.use("/api", healthRouter);

app.get("/", (_req, res) => {
  res.json({ message: "Welcome to ${name}" });
});

app.listen(port, () => {
  console.log("Server listening on http://localhost:" + port);
});
`,
    },
    {
      path: "README.md",
      content: readme(name, "A TypeScript Express API.", [
        "## Run",
        "",
        "```bash",
        "npm install",
        "npm run dev",
        "```",
        "",
        "Open `http://localhost:3000/api/health`.",
        "",
        "## Verify",
        "",
        "```bash",
        "npm run typecheck",
        "npm run build",
        "```",
      ]),
    },
    { path: ".gitignore", content: GITIGNORE },
  ],
};

const FASTAPI_TEMPLATE: TemplateDefinition = {
  id: "python-fastapi",
  name: "Python FastAPI",
  description: "FastAPI app with a health route, Pydantic model and pytest starter.",
  language: "Python",
  framework: "FastAPI",
  files: [
    "requirements.txt",
    "requirements-dev.txt",
    "app/__init__.py",
    "app/main.py",
    "tests/test_health.py",
    "README.md",
    ".gitignore",
  ],
  suggestedCommands: [
    "python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt",
    ".venv/bin/python -m uvicorn app.main:app --reload",
    ".venv/bin/python -m pytest -q",
  ],
  build: (name) => [
    { path: "requirements.txt", content: "fastapi>=0.115,<1\nuvicorn[standard]>=0.32,<1\n" },
    {
      path: "requirements-dev.txt",
      content: "-r requirements.txt\nhttpx>=0.27,<1\npytest>=8.3,<9\n",
    },
    { path: "app/__init__.py", content: "" },
    {
      path: "app/main.py",
      content: `from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="${name}")


class Message(BaseModel):
    text: str


@app.get("/")
def root() -> dict[str, str]:
    return {"message": "Welcome to ${name}"}


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True, "service": "${name}"}


@app.post("/api/echo")
def echo(message: Message) -> Message:
    return message
`,
    },
    {
      path: "tests/test_health.py",
      content: `from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_echo() -> None:
    response = client.post("/api/echo", json={"text": "hello"})
    assert response.status_code == 200
    assert response.json() == {"text": "hello"}
`,
    },
    {
      path: "README.md",
      content: readme(name, "A Python FastAPI service.", [
        "## Run",
        "",
        "Use Python 3.12–3.14 (3.15 can crash pandas/numpy).",
        "",
        "```bash",
        "python3 -m venv .venv",
        ".venv/bin/python -m pip install -r requirements-dev.txt",
        ".venv/bin/python -m uvicorn app.main:app --reload",
        "```",
        "",
        "Open `http://127.0.0.1:8000/docs`.",
        "",
        "## Verify",
        "",
        "```bash",
        ".venv/bin/python -m pytest -q",
        "```",
      ]),
    },
    { path: ".gitignore", content: GITIGNORE },
  ],
};

const PHP_TEMPLATE: TemplateDefinition = {
  id: "php-web",
  name: "PHP website",
  description: "A small PHP site with a reusable class and no Composer dependency.",
  language: "PHP",
  framework: "Vanilla PHP",
  files: ["public/index.php", "public/styles.css", "src/Greeter.php", "README.md", ".gitignore"],
  suggestedCommands: ["php -S localhost:8000 -t public"],
  build: (name) => [
    {
      path: "src/Greeter.php",
      content: `<?php

declare(strict_types=1);

namespace App;

final class Greeter
{
    public function __construct(private string $name)
    {
    }

    public function greet(): string
    {
        return "Hello from " . $this->name . "!";
    }
}
`,
    },
    {
      path: "public/index.php",
      content: `<?php

declare(strict_types=1);

require __DIR__ . "/../src/Greeter.php";

use App\\Greeter;

$greeter = new Greeter("${name}");
?><!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="card">
      <p class="eyebrow">PHP starter</p>
      <h1><?= htmlspecialchars($greeter->greet(), ENT_QUOTES, "UTF-8") ?></h1>
      <p>Edit <code>public/index.php</code> and <code>src/Greeter.php</code>.</p>
    </main>
  </body>
</html>
`,
    },
    {
      path: "public/styles.css",
      content: `:root {
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #080b10;
  color: #e6edf7;
}

* {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at top, #14243b, #080b10 55%);
}

.card {
  width: min(560px, calc(100vw - 32px));
  padding: 32px;
  border: 1px solid #233246;
  border-radius: 18px;
  background: rgba(13, 20, 31, 0.9);
}

.eyebrow {
  margin: 0 0 8px;
  color: #5eead4;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 12px;
}

p {
  color: #9fb3cc;
  line-height: 1.6;
}

code {
  color: #c5dcff;
}
`,
    },
    {
      path: "README.md",
      content: readme(name, "A dependency-free PHP website.", [
        "## Run",
        "",
        "```bash",
        "php -S localhost:8000 -t public",
        "```",
        "",
        "Open `http://localhost:8000`.",
      ]),
    },
    { path: ".gitignore", content: "vendor/\n.DS_Store\n*.log\n" },
  ],
};

const BLANK_TEMPLATE: TemplateDefinition = {
  id: "blank",
  name: "Blank project",
  description: "Only a README and .gitignore. Use the agent to choose the stack and create files.",
  language: "Any",
  files: ["README.md", ".gitignore"],
  suggestedCommands: [],
  build: (name) => [
    {
      path: "README.md",
      content: readme(name, "A blank project created in Code Studio.", [
        "Ask the agent to choose a stack and build the first files.",
      ]),
    },
    { path: ".gitignore", content: GITIGNORE },
  ],
};

const TEMPLATES: TemplateDefinition[] = [
  BLANK_TEMPLATE,
  STATIC_TEMPLATE,
  REACT_TEMPLATE,
  EXPRESS_TEMPLATE,
  FASTAPI_TEMPLATE,
  PHP_TEMPLATE,
  ...EXTRA_TEMPLATES,
];

function templateById(id: string): TemplateDefinition {
  const template = TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error("Unknown project template.");
  return template;
}

export function listProjectTemplates(): ProjectTemplate[] {
  return TEMPLATES.map(({ build: _build, ...template }) => template);
}

export async function scaffoldProject(request: ScaffoldProjectRequest): Promise<ScaffoldProjectResult> {
  const parentInput = typeof request.parentPath === "string" ? request.parentPath.trim() : "";
  const name = typeof request.name === "string" ? request.name.trim() : "";
  const templateId = typeof request.template === "string" ? request.template : "";
  if (!parentInput) throw new Error("A parent folder is required.");
  if (!NAME_PATTERN.test(name) || name.includes("..")) {
    throw new Error("Use a project name with letters, numbers, dots, dashes or underscores (max 64).");
  }
  const template = templateById(templateId);

  const expandedParent = parentInput.startsWith("~")
    ? path.join(process.env.HOME || "", parentInput.slice(1))
    : parentInput;
  let realParent: string;
  try {
    realParent = await fs.realpath(expandedParent);
  } catch {
    // Non-technical users often type a new parent folder. Creating it is
    // friendlier than failing, and the target is still validated below.
    try {
      await fs.mkdir(expandedParent, { recursive: true });
      realParent = await fs.realpath(expandedParent);
    } catch {
      throw new Error("The parent folder does not exist and could not be created.");
    }
  }
  const parentStat = await fs.stat(realParent);
  if (!parentStat.isDirectory()) throw new Error("The parent path is not a folder.");

  const rootPath = path.resolve(realParent, name);
  if (rootPath === realParent || !isWithin(realParent, rootPath)) {
    throw new Error("The project folder must be inside the selected parent folder.");
  }

  let createdRoot = false;
  try {
    const existing = await fs.stat(rootPath);
    if (!existing.isDirectory()) throw new Error("A file with this project name already exists.");
    const entries = await fs.readdir(rootPath);
    if (entries.length > 0) {
      throw new Error("The target folder already exists and is not empty. Choose another name.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.mkdir(rootPath, { recursive: false });
      createdRoot = true;
    } else {
      throw error;
    }
  }

  const files = template.build(name);
  const written: string[] = [];
  try {
    for (const file of files) {
      const target = path.resolve(rootPath, file.path);
      if (!isWithin(rootPath, target) || target === rootPath) {
        throw new Error("Template file path escaped the project folder.");
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, "utf8");
      written.push(file.path);
    }
  } catch (error) {
    if (createdRoot) {
      await fs.rm(rootPath, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }

  const pythonPlan =
    (template.language === "Python" || template.id.includes("python")) &&
    written.some((file) => file.startsWith("requirements"))
      ? await planPythonEnvironment(rootPath)
      : null;
  const suggestedCommands = pythonPlan
    ? [pythonPlan.command, ...template.suggestedCommands.slice(1)]
    : template.suggestedCommands;

  return {
    rootPath,
    name,
    template: template.id,
    filesCreated: written,
    warnings: template.id === "php-web" ? ["PHP files are shown as source; no PHP runtime preview is started."] : [],
    suggestedCommands,
  };
}
