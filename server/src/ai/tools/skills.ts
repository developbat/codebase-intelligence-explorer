import {
  listSkills,
  loadSkillForRun,
  setSkillEnabled,
} from "../../skills";
import {
  installSkills,
  previewSkillSource,
  removeInstalledSkill,
} from "../../skillInstall";
import type { AgentToolHandler, AgentToolResult } from "./types";

const listSkillsHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const listed = await listSkills(context.analysis.rootPath, context.projectId);
  const enabled = listed.skills.filter((skill) => skill.enabled);
  context.log("info", "Skills listed", `${listed.skills.length} total · ${enabled.length} enabled`);
  return {
    observation: [
      `${listed.skills.length} skills · ${enabled.length} enabled`,
      ...listed.skills.slice(0, 30).map(
        (skill) =>
          `${skill.enabled ? "on" : "off"} · ${skill.name} · ${skill.scope} · ${skill.key}${
            skill.description ? ` · ${skill.description}` : ""
          }`,
      ),
    ].join("\n"),
    ok: true,
  };
};

const loadSkillHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const key = typeof context.args.key === "string" ? context.args.key.trim() : "";
  if (!key) throw new Error("A skill key is required. Use list_skills to find it.");
  const skill = await loadSkillForRun(context.analysis.rootPath, context.projectId, key);
  context.log("info", "Skill loaded", `${skill.record.name} · ${skill.content.length} chars`);
  return {
    observation: [
      `Skill loaded for this run: ${skill.record.name} (${skill.record.key}) · ${skill.record.scope}`,
      skill.record.description ? `Description: ${skill.record.description}` : "",
      skill.record.allowedTools ? `Tools: ${skill.record.allowedTools}` : "",
      "",
      skill.content,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    ok: true,
  };
};

const previewSkillSourceHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const source = typeof context.args.source === "string" ? context.args.source.trim() : "";
  if (!source) throw new Error("A skill source is required.");
  const preview = await previewSkillSource(
    source,
    typeof context.args.ref === "string" ? context.args.ref : undefined,
  );
  context.log("success", "Skill source previewed", `${preview.candidates.length} candidates`);
  return {
    observation: [
      `${preview.repository ?? preview.source} · ${preview.ref} · ${preview.candidates.length} candidates`,
      ...preview.candidates.map(
        (candidate) =>
          `${candidate.name} (id: ${candidate.id}) · ${candidate.files.length} files${
            candidate.hasScripts ? " · contains scripts (never executed)" : ""
          } · ${candidate.description || "no description"}`,
      ),
      ...preview.warnings,
    ].join("\n"),
    ok: true,
  };
};

const installSkillHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const source = typeof context.args.source === "string" ? context.args.source.trim() : "";
  const skills = Array.isArray(context.args.skills)
    ? context.args.skills.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : [];
  if (!source) throw new Error("A skill source is required.");
  if (skills.length === 0) {
    throw new Error("Pass candidate ids from preview_skill_source in the skills array.");
  }
  const scope = context.args.scope === "global" ? "global" : "project";
  const allowed = await context.requirePermission(
    "write",
    "install_skill",
    source,
    `Install ${skills.length} skill(s) into ${scope} skills. Scripts are stored but never executed.`,
    { preview: skills.join(", ") },
  );
  if (!allowed) throw new Error("The user denied permission to install these skills.");
  const installed = await installSkills(context.analysis.rootPath, context.projectId, {
    source,
    ref: typeof context.args.ref === "string" ? context.args.ref : undefined,
    skills,
    scope,
    enable: context.args.enable === true,
  });
  context.log(
    "success",
    "Skills installed",
    installed.installed.map((skill) => skill.name).join(", "),
  );
  return {
    observation: [
      `Installed ${installed.installed.length} skill(s) into ${scope}.`,
      ...installed.installed.map(
        (skill) => `${skill.name} · ${skill.key}${skill.enabled ? " · enabled" : ""}`,
      ),
      `Registry: ${installed.registryPath}`,
      ...installed.warnings,
    ].join("\n"),
    ok: true,
  };
};

const setSkillEnabledHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const key = typeof context.args.key === "string" ? context.args.key.trim() : "";
  const enabled = context.args.enabled === true;
  if (!key) throw new Error("A skill key is required.");
  const allowed = await context.requirePermission(
    "write",
    "set_skill_enabled",
    key,
    enabled ? "Enable this skill for the agent prompt." : "Disable this skill.",
  );
  if (!allowed) throw new Error("The user denied permission to update this skill.");
  await setSkillEnabled(context.analysis.rootPath, context.projectId, key, enabled);
  context.log("success", "Skill updated", key);
  return { observation: `${key} is now ${enabled ? "enabled" : "disabled"}.`, ok: true };
};

const removeSkillHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const key = typeof context.args.key === "string" ? context.args.key.trim() : "";
  if (!key) throw new Error("A skill key is required.");
  const allowed = await context.requirePermission(
    "write",
    "remove_skill",
    key,
    "Remove an installed skill folder. This cannot be undone.",
    { destructive: true },
  );
  if (!allowed) throw new Error("The user denied permission to remove this skill.");
  await removeInstalledSkill(context.analysis.rootPath, context.projectId, key);
  context.log("success", "Skill removed", key);
  return { observation: `Removed ${key}.`, ok: true };
};

export const SKILL_TOOL_HANDLERS: Record<string, AgentToolHandler> = {
  list_skills: listSkillsHandler,
  load_skill: loadSkillHandler,
  preview_skill_source: previewSkillSourceHandler,
  install_skill: installSkillHandler,
  set_skill_enabled: setSkillEnabledHandler,
  remove_skill: removeSkillHandler,
};
