/**
 * Environment for project commands.
 *
 * The IDE server runs with `PORT`, `CIE_*` and Electron-specific variables
 * that belong to the app itself, not to the user's project. Passing them to
 * child processes makes `node server.js` bind the IDE's port (and then the
 * preview opens the IDE instead of the project). Keep project processes on
 * their own defaults; an explicit `PORT=...` inside the command still works.
 */
const IDE_ENV_KEYS = new Set([
  "PORT",
  "CIE_APP_ROOT",
  "CIE_BROWSER_BASE",
  "CIE_CHROME_PATH",
  "CIE_DATA_DIR",
  "CIE_SERVE_WEB",
  "CIE_TOOL_INPUT",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ASAR",
]);

function isIdeEnvKey(key: string): boolean {
  return IDE_ENV_KEYS.has(key) || key.startsWith("CIE_") || key.startsWith("ELECTRON_");
}

export function projectProcessEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isIdeEnvKey(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
