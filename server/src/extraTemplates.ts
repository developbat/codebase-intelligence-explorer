import type { ProjectTemplate } from "../../shared/types";

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface ExtraTemplateDefinition extends ProjectTemplate {
  build: (name: string) => ScaffoldFile[];
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, 64) || "app"
  );
}

function readme(name: string, title: string, lines: string[]): string {
  return [`# ${name}`, "", title, "", ...lines, ""].join("\n");
}

const GITIGNORE = `node_modules/\ndist/\nbuild/\n.env\n.env.*\n!.env.example\n.DS_Store\n*.log\n`;

const CANVAS_GAME: ExtraTemplateDefinition = {
  id: "canvas-game",
  name: "Canvas game",
  description: "A dependency-free HTML5 canvas arcade game with score, timer, touch input and restart.",
  language: "HTML / CSS / JavaScript",
  framework: "Canvas 2D",
  files: ["index.html", "styles.css", "game.js", "README.md", ".gitignore"],
  suggestedCommands: ["python3 -m http.server 8000"],
  build: (name) => [
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>${name}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="game-shell">
      <header class="hud">
        <span>Score <strong id="score">0</strong></span>
        <span>Time <strong id="time">30</strong>s</span>
        <button id="restart" type="button">Restart</button>
      </header>
      <canvas id="game" aria-label="Catch the target game"></canvas>
      <p id="status" class="status" aria-live="polite">Tap the glowing target.</p>
    </main>
    <script src="./game.js"></script>
  </body>
</html>
`,
    },
    {
      path: "styles.css",
      content: `:root {
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #070b12;
  color: #e9f2ff;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
  margin: 0;
  overscroll-behavior: none;
}

body {
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 50% 10%, #142b4a, #070b12 60%);
}

.game-shell {
  width: min(560px, 100vw);
  padding: 14px;
}

.hud {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border: 1px solid #23334a;
  border-radius: 12px 12px 0 0;
  background: #0b1420;
  font-size: 13px;
}

.hud strong {
  color: #5eead4;
  font-size: 16px;
}

.hud button {
  margin-left: auto;
  padding: 6px 12px;
  border: 1px solid #2b5f8f;
  border-radius: 7px;
  background: #153352;
  color: #d7ecff;
  font: inherit;
  font-size: 12px;
}

canvas {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 4 / 5;
  border: 1px solid #23334a;
  border-top: 0;
  border-radius: 0 0 12px 12px;
  background: #05080d;
  touch-action: none;
}

.status {
  margin: 10px 0 0;
  color: #8fa9c9;
  font-size: 12px;
  text-align: center;
}
`,
    },
    {
      path: "game.js",
      content: `const canvas = document.querySelector("#game");
const scoreEl = document.querySelector("#score");
const timeEl = document.querySelector("#time");
const statusEl = document.querySelector("#status");
const restartButton = document.querySelector("#restart");

const state = {
  score: 0,
  timeLeft: 30,
  running: false,
  target: { x: 0.5, y: 0.5, r: 44 },
  last: 0,
  tickTimer: null,
};

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function placeTarget() {
  state.target.x = 0.12 + Math.random() * 0.76;
  state.target.y = 0.12 + Math.random() * 0.76;
  state.target.r = 30 + Math.random() * 18;
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const ctx = canvas.getContext("2d");
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(
    state.target.x * w,
    state.target.y * h,
    2,
    state.target.x * w,
    state.target.y * h,
    state.target.r * 2.2,
  );
  glow.addColorStop(0, "rgba(94,234,212,0.55)");
  glow.addColorStop(1, "rgba(94,234,212,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(state.target.x * w, state.target.y * h, state.target.r * 2.2, 0, Math.PI * 2);
  ctx.fill();
  const body = ctx.createRadialGradient(
    state.target.x * w - state.target.r * 0.25,
    state.target.y * h - state.target.r * 0.25,
    3,
    state.target.x * w,
    state.target.y * h,
    state.target.r,
  );
  body.addColorStop(0, "#d9fff7");
  body.addColorStop(0.55, "#5eead4");
  body.addColorStop(1, "#0f766e");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(state.target.x * w, state.target.y * h, state.target.r, 0, Math.PI * 2);
  ctx.fill();
}

function start() {
  state.score = 0;
  state.timeLeft = 30;
  state.running = true;
  scoreEl.textContent = "0";
  timeEl.textContent = "30";
  statusEl.textContent = "Catch the target before the time runs out.";
  placeTarget();
  draw();
  clearInterval(state.tickTimer);
  state.tickTimer = setInterval(() => {
    if (!state.running) return;
    state.timeLeft -= 1;
    timeEl.textContent = String(state.timeLeft);
    if (state.timeLeft <= 0) end();
  }, 1000);
}

function end() {
  state.running = false;
  clearInterval(state.tickTimer);
  statusEl.textContent = "Finished with " + state.score + " points. Press Restart.";
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  ctx.fillStyle = "rgba(3,7,12,0.72)";
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#e9f2ff";
  ctx.textAlign = "center";
  ctx.font = "600 20px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("Game over", rect.width / 2, rect.height / 2 - 8);
  ctx.fillStyle = "#5eead4";
  ctx.font = "700 34px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(String(state.score), rect.width / 2, rect.height / 2 + 32);
}

function pointer(event) {
  if (!state.running) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const dx = x - state.target.x * rect.width;
  const dy = y - state.target.y * rect.height;
  if (Math.hypot(dx, dy) <= state.target.r + 10) {
    state.score += 1;
    scoreEl.textContent = String(state.score);
    placeTarget();
    draw();
  }
}

canvas.addEventListener("pointerdown", pointer);
restartButton.addEventListener("click", start);
window.addEventListener("resize", () => {
  resize();
  if (!state.running) draw();
});

resize();
placeTarget();
draw();
start();
`,
    },
    {
      path: "README.md",
      content: readme(name, "A dependency-free HTML5 canvas arcade game.", [
        "## Run",
        "",
        "```bash",
        "python3 -m http.server 8000",
        "```",
        "",
        "Open `http://localhost:8000` and tap the glowing target.",
        "",
        "## Extend",
        "",
        "- Add levels, sound and high scores in `game.js`.",
        "- Replace the canvas drawing with sprites.",
        "- Use `browser_check` to test score/restart flows.",
      ]),
    },
    { path: ".gitignore", content: "node_modules/\n.DS_Store\n*.log\n" },
  ],
};

const PWA_MOBILE: ExtraTemplateDefinition = {
  id: "pwa-mobile",
  name: "Mobile PWA",
  description: "Installable mobile-first web app with offline cache, localStorage and app manifest.",
  language: "HTML / CSS / JavaScript",
  framework: "PWA",
  files: [
    "index.html",
    "styles.css",
    "app.js",
    "manifest.webmanifest",
    "sw.js",
    "icons/icon.svg",
    "README.md",
    ".gitignore",
  ],
  suggestedCommands: ["python3 -m http.server 8000"],
  build: (name) => [
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0b1220" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="icon" href="./icons/icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="./styles.css" />
    <title>${name}</title>
  </head>
  <body>
    <main class="app-shell">
      <header>
        <p class="eyebrow">Daily focus</p>
        <h1>${name}</h1>
        <p class="muted">Install this page from your browser menu. Data stays on this device.</p>
      </header>

      <form id="add-form" class="add-row">
        <input id="focus-input" type="text" placeholder="What matters today?" autocomplete="off" />
        <button type="submit">Add</button>
      </form>

      <p class="counter" aria-live="polite">
        <strong id="done-count">0</strong> / <span id="total-count">0</span> completed
      </p>

      <ul id="focus-list" class="focus-list"></ul>
      <p id="status" class="status" aria-live="polite"></p>
    </main>
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
  background: #070b12;
  color: #e9f2ff;
}

* {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  margin: 0;
  padding: max(18px, env(safe-area-inset-top)) 16px max(18px, env(safe-area-inset-bottom));
  background: radial-gradient(circle at 50% 0%, #16304f, #070b12 58%);
}

.app-shell {
  width: min(460px, 100%);
  margin: 0 auto;
}

.eyebrow {
  margin: 0 0 4px;
  color: #5eead4;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 6px;
  font-size: clamp(26px, 7vw, 38px);
}

.muted {
  margin: 0 0 18px;
  color: #8fa9c9;
  font-size: 12px;
  line-height: 1.5;
}

.add-row {
  display: flex;
  gap: 8px;
}

.add-row input {
  flex: 1;
  min-width: 0;
  height: 46px;
  padding: 0 13px;
  border: 1px solid #2a3c55;
  border-radius: 10px;
  background: #0b1420;
  color: #e9f2ff;
  font: inherit;
}

.add-row button {
  height: 46px;
  padding: 0 16px;
  border: 0;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  font: inherit;
  font-weight: 600;
}

.counter {
  margin: 14px 0 8px;
  color: #8fa9c9;
  font-size: 12px;
}

.counter strong {
  color: #5eead4;
}

.focus-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.focus-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 12px;
  border: 1px solid #24364d;
  border-radius: 10px;
  background: #0c1624;
}

.focus-item.is-done .focus-text {
  color: #64748b;
  text-decoration: line-through;
}

.focus-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.focus-actions {
  display: flex;
  gap: 4px;
}

.focus-actions button {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #8fa9c9;
  font: inherit;
  font-size: 11px;
  padding: 5px 7px;
}

.focus-actions button:hover {
  background: #172436;
  color: #fff;
}

.status {
  min-height: 18px;
  margin: 12px 0 0;
  color: #e6c284;
  font-size: 11px;
  text-align: center;
}
`,
    },
    {
      path: "app.js",
      content: `(function () {
  "use strict";
  var STORAGE_KEY = "pwa-mobile:focus";
  var form = document.querySelector("#add-form");
  var input = document.querySelector("#focus-input");
  var list = document.querySelector("#focus-list");
  var doneCount = document.querySelector("#done-count");
  var totalCount = document.querySelector("#total-count");
  var statusEl = document.querySelector("#status");
  var items = load();

  function load() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function save() {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  function render() {
    list.textContent = "";
    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "focus-item" + (item.done ? " is-done" : "");
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.done;
      checkbox.addEventListener("change", function () {
        item.done = checkbox.checked;
        save();
        render();
      });
      var text = document.createElement("span");
      text.className = "focus-text";
      text.textContent = item.text;
      var actions = document.createElement("div");
      actions.className = "focus-actions";
      var remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", function () {
        items = items.filter(function (candidate) {
          return candidate.id !== item.id;
        });
        save();
        render();
      });
      actions.appendChild(remove);
      li.appendChild(checkbox);
      li.appendChild(text);
      li.appendChild(actions);
      list.appendChild(li);
    });
    var done = items.filter(function (item) {
      return item.done;
    }).length;
    doneCount.textContent = String(done);
    totalCount.textContent = String(items.length);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) {
      statusEl.textContent = "Write a focus item first.";
      return;
    }
    items.push({ id: Date.now(), text: text, done: false });
    input.value = "";
    statusEl.textContent = "Added.";
    save();
    render();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () {
        // offline cache is optional
      });
    });
  }

  render();
})();
`,
    },
    {
      path: "manifest.webmanifest",
      content: `${JSON.stringify(
        {
          name,
          short_name: name.slice(0, 12),
          start_url: ".",
          display: "standalone",
          background_color: "#070b12",
          theme_color: "#0b1220",
          icons: [{ src: "icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "sw.js",
      content: `const CACHE = "pwa-mobile-v1";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
`,
    },
    {
      path: "icons/icon.svg",
      content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="#0b1220"/>
  <circle cx="256" cy="256" r="154" fill="url(#g)" opacity="0.22"/>
  <path d="M176 344V168h56l48 96 48-96h56v176h-48V244l-40 80h-32l-40-80v100z" fill="url(#g)"/>
</svg>
`,
    },
    {
      path: "README.md",
      content: readme(name, "An installable mobile-first PWA.", [
        "## Run",
        "",
        "```bash",
        "python3 -m http.server 8000",
        "```",
        "",
        "Open `http://localhost:8000` on desktop or phone. Use the browser menu to install.",
        "",
        "Data is stored in localStorage; the service worker caches the shell for offline use.",
      ]),
    },
    { path: ".gitignore", content: "node_modules/\n.DS_Store\n*.log\n" },
  ],
};

const EXPO_MOBILE: ExtraTemplateDefinition = {
  id: "expo-mobile",
  name: "Expo mobile app",
  description: "React Native + Expo + TypeScript mobile app with web preview and device scripts.",
  language: "TypeScript / React Native",
  framework: "Expo",
  files: [
    "package.json",
    "app.json",
    "App.tsx",
    "src/theme.ts",
    "tsconfig.json",
    "babel.config.js",
    "README.md",
    ".gitignore",
  ],
  suggestedCommands: ["npm install", "npm run web", "npm run ios", "npm run android"],
  build: (name) => [
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: slug(name),
          version: "1.0.0",
          private: true,
          main: "expo/AppEntry.js",
          scripts: {
            start: "expo start",
            web: "expo start --web",
            ios: "expo start --ios",
            android: "expo start --android",
            typecheck: "tsc --noEmit",
          },
          dependencies: {
            "@expo/metro-runtime": "~3.2.3",
            expo: "~51.0.28",
            "expo-status-bar": "~1.12.1",
            react: "18.2.0",
            "react-dom": "18.2.0",
            "react-native": "0.74.5",
            "react-native-web": "~0.19.10",
          },
          devDependencies: {
            "@types/react": "~18.2.79",
            typescript: "~5.3.3",
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "app.json",
      content: `${JSON.stringify(
        {
          expo: {
            name,
            slug: slug(name),
            version: "1.0.0",
            orientation: "portrait",
            userInterfaceStyle: "dark",
            platforms: ["ios", "android", "web"],
            web: { bundler: "metro" },
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "App.tsx",
      content: `import { useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { colors } from "./src/theme";

interface Item {
  id: number;
  text: string;
  done: boolean;
}

export default function App() {
  const [text, setText] = useState("");
  const [items, setItems] = useState<Item[]>([]);

  function add() {
    const value = text.trim();
    if (!value) return;
    setItems((current) => [...current, { id: Date.now(), text: value, done: false }]);
    setText("");
  }

  function toggle(id: number) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, done: !item.done } : item)),
    );
  }

  function remove(id: number) {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  const done = items.filter((item) => item.done).length;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>MOBILE STARTER</Text>
        <Text style={styles.title}>${name}</Text>
        <Text style={styles.muted}>
          Expo + React Native + TypeScript. Run npm run web for this browser, or npm run ios /
          npm run android for a simulator.
        </Text>

        <View style={styles.row}>
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={add}
            placeholder="Add a focus item"
            placeholderTextColor={colors.dim}
            style={styles.input}
          />
          <Pressable onPress={add} style={styles.addButton}>
            <Text style={styles.addLabel}>Add</Text>
          </Pressable>
        </View>

        <Text style={styles.counter}>
          {done} / {items.length} done
        </Text>

        {items.map((item) => (
          <View key={item.id} style={styles.item}>
            <Pressable onPress={() => toggle(item.id)} style={styles.checkbox}>
              <Text style={styles.checkboxText}>{item.done ? "✓" : ""}</Text>
            </Pressable>
            <Text style={[styles.itemText, item.done && styles.doneText]}>{item.text}</Text>
            <Pressable onPress={() => remove(item.id)}>
              <Text style={styles.remove}>Delete</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  page: { padding: 22, gap: 12 },
  eyebrow: { color: colors.accent, fontSize: 11, letterSpacing: 1.5, fontWeight: "700" },
  title: { color: colors.text, fontSize: 34, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  row: { flexDirection: "row", gap: 8, marginTop: 10 },
  input: {
    flex: 1,
    height: 46,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    color: colors.text,
    paddingHorizontal: 12,
  },
  addButton: {
    height: 46,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: colors.blue,
    alignItems: "center",
    justifyContent: "center",
  },
  addLabel: { color: "#fff", fontWeight: "700" },
  counter: { color: colors.muted, fontSize: 12, marginTop: 4 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxText: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  itemText: { flex: 1, color: colors.text, fontSize: 14 },
  doneText: { color: colors.dim, textDecorationLine: "line-through" },
  remove: { color: colors.danger, fontSize: 12 },
});
`,
    },
    {
      path: "src/theme.ts",
      content: `export const colors = {
  bg: "#070b12",
  card: "#0c1624",
  line: "#24364d",
  text: "#e9f2ff",
  muted: "#8fa9c9",
  dim: "#64748b",
  accent: "#5eead4",
  blue: "#2563eb",
  danger: "#e59aa6",
};
`,
    },
    {
      path: "tsconfig.json",
      content: `${JSON.stringify(
        {
          extends: "expo/tsconfig.base",
          compilerOptions: { strict: true, noUnusedLocals: true, noUnusedParameters: true },
          include: ["**/*.ts", "**/*.tsx"],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "babel.config.js",
      content: `module.exports = function (api) {\n  api.cache(true);\n  return { presets: ["babel-preset-expo"] };\n};\n`,
    },
    {
      path: "README.md",
      content: readme(name, "A React Native Expo mobile app with TypeScript and web preview.", [
        "## Run",
        "",
        "```bash",
        "npm install",
        "npm run web",
        "```",
        "",
        "For simulators:",
        "",
        "```bash",
        "npm run ios",
        "npm run android",
        "```",
        "",
        "## Verify",
        "",
        "```bash",
        "npm run typecheck",
        "```",
        "",
        "The local machine has iOS Simulator, Android SDK/emulator and CocoaPods. Install Xcode/Android Studio tooling if a command is missing.",
      ]),
    },
    { path: ".gitignore", content: GITIGNORE },
  ],
};

export const EXTRA_TEMPLATES: ExtraTemplateDefinition[] = [
  CANVAS_GAME,
  PWA_MOBILE,
  EXPO_MOBILE,
];
