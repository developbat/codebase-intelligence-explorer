/**
 * Actionable hints for Python command failures. The agent must switch to the
 * project virtual environment instead of retrying a broken system interpreter.
 */
export function pythonEnvironmentHint(
  command: string,
  exitCode: number | null,
  output: string,
): string {
  const looksPython =
    /\b(python[0-9.]*|pip[0-9.]*|pytest|uvicorn|streamlit|flask|gunicorn|django)\b/i.test(command) ||
    /\b(python|pip)\b/i.test(output);
  if (!looksPython) return "";
  const hints: string[] = [];
  if (/externally-managed-environment/i.test(output)) {
    hints.push(
      "The system Python is externally managed. Install into the project virtual environment with `./.venv/bin/python -m pip install -r requirements.txt`; never use `--break-system-packages`.",
    );
  }
  if (exitCode === 139 || /Segmentation fault|SIGSEGV|Fatal Python error/i.test(output)) {
    hints.push(
      "The Python interpreter crashed (exit 139/SIGSEGV). Do not retry the same command. Use the project virtual environment (`./.venv/bin/python`), which the app creates with a stable Python 3.12/3.13; rebuild it with `python3.13 -m venv .venv` if it is missing.",
    );
  }
  if (/ModuleNotFoundError|No module named/i.test(output)) {
    hints.push(
      "A dependency is missing. Install it into the project venv with `./.venv/bin/python -m pip install -r requirements.txt` instead of the system interpreter.",
    );
  }
  if (hints.length === 0) return "";
  return `\n\nEnvironment hint: ${[...new Set(hints)].join(" ")}`;
}
