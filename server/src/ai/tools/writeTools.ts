import { createPlaceholderAsset } from "../../placeholderAssets";
import {
  createProjectTool,
  findProjectTool,
  listProjectTools,
  recordProjectToolRun,
  validateProjectToolInput,
} from "../../projectTools";
import { runProjectCommand } from "../../editor";
import { createSkill } from "../../skillInstall";
import { listSkills, runSkillScript } from "../../skills";
import { installToolchain } from "../../toolchains";
import type { AgentToolHandler, AgentToolResult } from "./types";

function clampObservation(text: string, limit = 6_000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… observation truncated …` : text;
}

const placeholderAssetHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const assetPath = context.normalizePath(context.pathFromArgs(context.args));
  if (!assetPath) throw new Error("An asset path is required.");
  if (context.isSecretPath(assetPath)) {
    throw new Error("Writing environment, key or Git internals assets is denied.");
  }
  const allowed = await context.requirePermission(
    "write",
    "placeholder_asset",
    assetPath,
    "Create a deterministic SVG placeholder asset.",
    { preview: String(context.args.kind ?? "icon") },
  );
  if (!allowed) throw new Error("The user denied permission to create this asset.");
  const created = await createPlaceholderAsset(context.analysis.rootPath, {
    path: assetPath,
    kind: context.args.kind as Parameters<typeof createPlaceholderAsset>[1]["kind"],
    width: Number(context.args.width) || undefined,
    height: Number(context.args.height) || undefined,
    label: typeof context.args.label === "string" ? context.args.label : undefined,
    color: typeof context.args.color === "string" ? context.args.color : undefined,
    background: typeof context.args.background === "string" ? context.args.background : undefined,
    format: context.args.format === "png" ? "png" : undefined,
    durationMs: Number(context.args.durationMs) || undefined,
    frequency: Number(context.args.frequency) || undefined,
    loop: context.args.loop === true,
    fps: Number(context.args.fps) || undefined,
  });
  if (!context.changedFiles.includes(created.path)) context.changedFiles.push(created.path);
  context.evidence.push({ path: created.path, label: "Placeholder asset" });
  context.log("success", "Placeholder asset created", created.path);
  return {
    observation: `Created ${created.kind} SVG placeholder: ${created.path} (${created.bytes} bytes).`,
    ok: true,
  };
};

const createProjectToolHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const name = String(context.args.name ?? "").trim();
  const code = String(context.args.code ?? "");
  if (!name || !code.trim()) throw new Error("Tool name and code are required.");
  const language =
    context.args.language === "ts"
      ? "ts"
      : context.args.language === "py"
        ? "py"
        : context.args.language === "sh"
          ? "sh"
          : "js";
  const allowed = await context.requirePermission(
    "write",
    "create_project_tool",
    name,
    `Create a reusable ${language} tool under .cie/agent/tools. It can be run later with run_project_tool.`,
    { preview: code.slice(0, 600) },
  );
  if (!allowed) throw new Error("The user denied permission to create this project tool.");
  const tool = await createProjectTool(context.analysis.rootPath, {
    name,
    description: typeof context.args.description === "string" ? context.args.description : undefined,
    whenToUse: typeof context.args.whenToUse === "string" ? context.args.whenToUse : undefined,
    inputSchema:
      context.args.inputSchema && typeof context.args.inputSchema === "object"
        ? (context.args.inputSchema as Parameters<typeof createProjectTool>[1]["inputSchema"])
        : undefined,
    timeoutMs: Number(context.args.timeoutMs) || undefined,
    language,
    code,
  });
  context.log("success", "Project tool created", tool.name);
  return {
    observation: `Created project tool: ${tool.name} · ${tool.path}\nRun it with run_project_tool name="${tool.name}".`,
    ok: true,
  };
};

const createSkillHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const name = String(context.args.name ?? "").trim();
  const description = String(context.args.description ?? "").trim();
  const body = String(context.args.body ?? "").trim();
  if (!name || !description || !body) {
    throw new Error("Skill name, description and instructions are required.");
  }
  const allowed = await context.requirePermission(
    "write",
    "create_skill",
    name,
    "Create a project skill under .cie/skills. It is enabled for this project unless enable=false.",
    { preview: body.slice(0, 600) },
  );
  if (!allowed) throw new Error("The user denied permission to create this skill.");
  const skill = await createSkill(context.analysis.rootPath, context.projectId, {
    name,
    description,
    body,
    allowedTools:
      typeof context.args.allowedTools === "string" ? context.args.allowedTools : undefined,
    enable: context.args.enable !== false,
  });
  context.log("success", "Skill created", skill.name);
  return {
    observation: `Created skill: ${skill.name} · ${skill.path}${skill.enabled ? " · enabled" : ""}`,
    ok: true,
  };
};

const installToolchainHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const id = String(context.args.id ?? "").trim();
  if (!id) throw new Error("A toolchain id is required.");
  const allowed = await context.requirePermission(
    "command",
    "install_toolchain",
    id,
    `Install the missing ${id} toolchain using the platform package manager.`,
  );
  if (!allowed) throw new Error("The user denied permission to install the toolchain.");
  const result = await installToolchain(id);
  context.log(
    result.ok ? "success" : "error",
    result.ok ? "Toolchain installed" : "Toolchain install failed",
    id,
  );
  return {
    observation: result.ok
      ? `${id} installed${result.command ? ` with: ${result.command}` : ""}.\n${result.output}`
      : `${id} install failed${result.command ? ` (${result.command})` : ""}.\n${result.output}`,
    ok: result.ok,
  };
};

const runProjectToolHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const name = String(context.args.name ?? "").trim();
  if (!name) throw new Error("A project tool name is required.");
  const tool = await findProjectTool(context.analysis.rootPath, name);
  if (!tool) {
    const available = await listProjectTools(context.analysis.rootPath).catch(() => null);
    const names = available?.tools.map((item) => item.name).filter(Boolean) ?? [];
    throw new Error(
      `Project tool "${name}" was not found.${
        names.length > 0
          ? ` Available project tools: ${names.slice(0, 20).join(", ")}.`
          : " No saved project tools exist in this project. Do not retry with another guessed name; use browser_check or run_command, or create one with create_project_tool."
      }`,
    );
  }
  const toolInput =
    context.args.input && typeof context.args.input === "object" && !Array.isArray(context.args.input)
      ? (context.args.input as Record<string, unknown>)
      : {};
  const inputError = validateProjectToolInput(tool, toolInput);
  if (inputError) throw new Error(inputError);
  const inputJson = Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput) : "";
  const allowed = await context.requirePermission(
    "command",
    "run_project_tool",
    tool.command,
    `Run saved project tool "${tool.name}".`,
    { preview: [tool.command, inputJson].filter(Boolean).join(" · ").slice(0, 1_000) },
  );
  if (!allowed) {
    return { observation: `Permission denied for project tool "${tool.name}".`, ok: false };
  }
  context.log("info", "Running project tool", `${tool.name} · ${tool.command}`);
  const result = await runProjectCommand(context.analysis.rootPath, tool.command, undefined, {
    timeoutMs: tool.timeoutMs ?? 120_000,
    signal: context.signal,
    env: inputJson ? { CIE_TOOL_INPUT: inputJson } : undefined,
    envMode: "safe",
  });
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  const ok = result.exitCode === 0;
  context.ranCommands.push(tool.name);
  await recordProjectToolRun(context.analysis.rootPath, tool.name, ok).catch(() => undefined);
  context.log(ok ? "success" : "error", ok ? "Project tool passed" : "Project tool failed", tool.name);
  return {
    observation: `Project tool "${tool.name}" · exit ${result.exitCode ?? "—"}${
      inputJson ? ` · input ${inputJson.slice(0, 300)}` : ""
    }\n${output || "(no output)"}`,
    ok,
  };
};

const runSkillScriptHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const skillName = String(context.args.skill ?? "").trim();
  const scriptPath = String(context.args.path ?? "").trim();
  if (!skillName || !scriptPath) {
    throw new Error("A skill name and script path are required.");
  }
  const skillList = await listSkills(context.analysis.rootPath, context.projectId);
  const skill = skillList.skills.find(
    (item) =>
      item.key === skillName || item.name.toLowerCase() === skillName.toLowerCase(),
  );
  if (!skill) throw new Error(`Skill not found: ${skillName}`);
  const script = skill.files.find(
    (file) => file.kind === "script" && file.path === scriptPath,
  );
  if (!script) throw new Error("Only scripts listed by this skill can be run.");
  const scriptArgs = Array.isArray(context.args.args)
    ? context.args.args
        .filter((value): value is string => typeof value === "string")
        .slice(0, 20)
    : [];
  const allowed = await context.requirePermission(
    "command",
    "run_skill_script",
    `${skill.name}/${scriptPath}`,
    `Skill: ${skill.name}${scriptArgs.length > 0 ? ` · args: ${scriptArgs.join(" ")}` : ""}`,
    { preview: scriptPath, forceConfirm: true },
  );
  if (!allowed) throw new Error("The user denied permission to run this skill script.");
  const scriptResult = await runSkillScript(
    context.analysis.rootPath,
    context.projectId,
    skill.key,
    scriptPath,
    scriptArgs,
  );
  context.ranCommands.push(`${skill.name}/${scriptPath}`);
  context.log(
    scriptResult.exitCode === 0 ? "success" : "error",
    "Skill script finished",
    `exit ${scriptResult.exitCode ?? "—"} · ${scriptResult.durationMs} ms`,
  );
  return {
    observation: clampObservation(
      `$ ${scriptResult.command}\nexit ${scriptResult.exitCode ?? "—"} · ${scriptResult.durationMs} ms\n\n${scriptResult.output}`,
    ),
    ok: scriptResult.exitCode === 0,
  };
};

export const WRITE_TOOL_HANDLERS: Record<string, AgentToolHandler> = {
  placeholder_asset: placeholderAssetHandler,
  create_project_tool: createProjectToolHandler,
  create_skill: createSkillHandler,
  install_toolchain: installToolchainHandler,
  run_project_tool: runProjectToolHandler,
  run_skill_script: runSkillScriptHandler,
};
