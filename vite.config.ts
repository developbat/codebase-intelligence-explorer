import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DOCS_LOGO = path.join(ROOT, "docs", "cbe.png");
const PUBLIC_LOGO = path.join(ROOT, "web", "public", "cbe.png");

function syncLogo(): void {
  if (!fs.existsSync(DOCS_LOGO)) return;
  try {
    fs.mkdirSync(path.dirname(PUBLIC_LOGO), { recursive: true });
    fs.copyFileSync(DOCS_LOGO, PUBLIC_LOGO);
  } catch (error) {
    console.warn("[cbe] could not sync docs/cbe.png:", error);
  }
}

/**
 * The canonical logo lives in docs/cbe.png (outside the Vite root). Keep the
 * public copy in sync and trigger a full reload so the brand, favicon and
 * manifest all pick up the new image without restarting the dev server.
 */
function logoSyncPlugin(): Plugin {
  let lastMtime = 0;
  return {
    name: "cbe-logo-sync",
    buildStart() {
      syncLogo();
    },
    configureServer(server) {
      const onFile = (filePath: string) => {
        const resolved = path.resolve(filePath);
        if (resolved === DOCS_LOGO) {
          const stat = fs.statSync(DOCS_LOGO);
          if (stat.mtimeMs === lastMtime) return;
          lastMtime = stat.mtimeMs;
          syncLogo();
        } else if (resolved !== PUBLIC_LOGO) {
          return;
        }
        server.ws.send({ type: "full-reload" });
      };
      if (fs.existsSync(DOCS_LOGO)) server.watcher.add(DOCS_LOGO);
      server.watcher.on("change", onFile);
      server.watcher.on("add", onFile);
    },
  };
}

export default defineConfig({
  root: "web",
  plugins: [react(), logoSyncPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // ELK is loaded lazily as its own chunk; the main bundle stays below 500 kB.
    chunkSizeWarningLimit: 1600,
  },
});
