import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  FileText,
  FolderOpen,
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type {
  SkillDetail,
  SkillInstallScope,
  SkillListResponse,
  SkillRecord,
  SkillSourcePreview,
} from "../../../shared/skills";
import { api } from "../api";
import { useI18n } from "../i18n";
import { readCache, writeCache } from "../lib/resourceCache";

interface SkillsPanelProps {
  projectId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SkillsPanel({ projectId }: SkillsPanelProps) {
  const { t } = useI18n();
  const [data, setData] = useState<SkillListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "project" | "global" | "external">("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [source, setSource] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [scopeChoice, setScopeChoice] = useState<SkillInstallScope>("project");
  const [enableOnInstall, setEnableOnInstall] = useState(true);
  const [preview, setPreview] = useState<SkillSourcePreview | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [previewBusy, setPreviewBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.skills.list(projectId);
      setData(result);
      writeCache(`skills:${projectId}`, result);
      setReloadToken((value) => value + 1);
      setSelectedKey((current) => {
        if (current && result.skills.some((skill) => skill.key === current)) return current;
        return result.skills[0]?.key ?? null;
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not load skills."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setData(null);
    setSelectedKey(null);
    setDetail(null);
    setSelectedFile(null);
    setFileContent(null);
    setQuery("");
    setScope("all");
    const cached = readCache<SkillListResponse>(`skills:${projectId}`, 60_000);
    if (cached?.value && !cached.stale) {
      setData(cached.value);
      setSelectedKey((current) =>
        current && cached.value.skills.some((skill) => skill.key === current)
          ? current
          : cached.value.skills[0]?.key ?? null,
      );
      setLoading(false);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!selectedKey) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    setSelectedFile(null);
    setFileContent(null);
    api.skills
      .get(projectId, selectedKey)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setDetailError(
            requestError instanceof Error ? requestError.message : t("Could not load this skill."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedKey, reloadToken]);

  const visible = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.skills.filter((skill) => {
      if (scope !== "all" && skill.scope !== scope) return false;
      if (!needle) return true;
      return `${skill.name} ${skill.description} ${skill.sourceLabel} ${skill.allowedTools ?? ""}`
        .toLowerCase()
        .includes(needle);
    });
  }, [data, query, scope]);

  async function toggleSkill(skill: SkillRecord, enabled: boolean) {
    setBusyKey(skill.key);
    setError(null);
    try {
      await api.skills.setEnabled(projectId, skill.key, enabled);
      setData((current) => {
        if (!current) return current;
        const skills = current.skills.map((item) =>
          item.key === skill.key ? { ...item, enabled } : item,
        );
        return {
          ...current,
          skills,
          enabledCount: skills.filter((item) => item.enabled).length,
        };
      });
      setDetail((current) => (current && current.key === skill.key ? { ...current, enabled } : current));
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t("Could not update this skill."),
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function previewSource() {
    if (!source.trim()) return;
    setPreviewBusy(true);
    setAddMessage(null);
    try {
      const result = await api.skills.previewSource(projectId, source.trim(), sourceRef.trim() || undefined);
      setPreview(result);
      setSelectedCandidates(new Set(result.candidates.map((candidate) => candidate.id)));
    } catch (requestError) {
      setAddMessage(
        requestError instanceof Error ? requestError.message : t("Could not preview this skill source."),
      );
    } finally {
      setPreviewBusy(false);
    }
  }

  async function installSelected() {
    if (!preview || selectedCandidates.size === 0) return;
    setInstallBusy(true);
    setAddMessage(null);
    try {
      const result = await api.skills.install(projectId, {
        source: preview.source,
        ref: preview.ref,
        skills: [...selectedCandidates],
        scope: scopeChoice,
        enable: enableOnInstall,
      });
      setAddMessage(
        t("{count} skills installed · {path}", {
          count: result.installed.length,
          path: result.registryPath,
        }),
      );
      setAddOpen(false);
      setPreview(null);
      setSource("");
      await load();
    } catch (requestError) {
      setAddMessage(
        requestError instanceof Error ? requestError.message : t("Could not install these skills."),
      );
    } finally {
      setInstallBusy(false);
    }
  }

  async function updateSkill(skill: SkillDetail) {
    if (busyKey) return;
    setBusyKey(skill.key);
    setAddMessage(null);
    try {
      const result = await api.skills.update(projectId, skill.key);
      setAddMessage(t("Skill updated from {source}.", { source: result.ref }));
      await load();
    } catch (requestError) {
      setAddMessage(
        requestError instanceof Error ? requestError.message : t("Could not update this skill."),
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function removeSkill(skill: SkillDetail) {
    if (busyKey) return;
    setBusyKey(skill.key);
    try {
      await api.skills.remove(projectId, skill.key);
      setDetail(null);
      setAddMessage(t("Skill removed."));
      await load();
    } catch (requestError) {
      setAddMessage(
        requestError instanceof Error ? requestError.message : t("Could not remove this skill."),
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function openFile(filePath: string) {
    if (!selectedKey) return;
    setFileLoading(true);
    setDetailError(null);
    try {
      const result = await api.skills.readFile(projectId, selectedKey, filePath);
      setSelectedFile(result.path);
      setFileContent(result.content);
    } catch (requestError) {
      setDetailError(
        requestError instanceof Error ? requestError.message : t("Could not read this skill file."),
      );
    } finally {
      setFileLoading(false);
    }
  }

  const enabledCount = data?.enabledCount ?? 0;
  const sourcesFound = data?.sources.filter((source) => source.exists) ?? [];

  return (
    <div className="skills-panel">
      <div className="skills-head">
        <div>
          <strong>
            <Sparkles size={14} /> {t("Skills")}
          </strong>
          <span>
            {t("{count} skills found", { count: data?.skills.length ?? 0 })} · {enabledCount}{" "}
            {t("enabled")}
          </span>
        </div>
        <div className="skills-head-actions">
          <button className="ghost-button" onClick={() => setAddOpen((value) => !value)}>
            <Plus size={12} /> {t("Add from GitHub")}
          </button>
          <button className="ghost-button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? "spin" : ""} /> {t("Rescan skills")}
          </button>
        </div>
      </div>

      <p className="skills-intro">
        {t(
          "Skills are SKILL.md instruction packs discovered from project and global agent folders. Disabled skills are never sent to the model. Scripts are not executed.",
        )}
      </p>

      {addOpen ? (
        <div className="skills-add-panel">
          <div className="skills-add-row">
            <input
              className="text-input mono"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="owner/repo, GitHub URL or local folder"
              spellCheck={false}
            />
            <input
              className="text-input mono"
              value={sourceRef}
              onChange={(event) => setSourceRef(event.target.value)}
              placeholder={t("ref (optional)")}
              spellCheck={false}
            />
            <button className="ghost-button" onClick={() => void previewSource()} disabled={previewBusy || !source.trim()}>
              {previewBusy ? <Loader2 size={11} className="spin" /> : <Search size={11} />}
              {t("Preview source")}
            </button>
          </div>
          <div className="skills-add-options">
            <label>
              {t("Scope")}
              <select
                className="settings-select"
                value={scopeChoice}
                onChange={(event) => setScopeChoice(event.target.value as SkillInstallScope)}
              >
                <option value="project">{t("Project")}</option>
                <option value="global">{t("Global")}</option>
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={enableOnInstall}
                onChange={(event) => setEnableOnInstall(event.target.checked)}
              />
              {t("Enable after install")}
            </label>
            <span>{t("Scripts are not executed.")}</span>
          </div>
          {preview ? (
            <div className="skills-candidates">
              <div className="skills-candidates-head">
                <span>
                  {preview.repository ?? preview.source} · {preview.ref} · {preview.candidates.length}{" "}
                  {t("skills")}
                </span>
                <button
                  className="ghost-button"
                  onClick={() =>
                    setSelectedCandidates(
                      selectedCandidates.size === preview.candidates.length
                        ? new Set()
                        : new Set(preview.candidates.map((candidate) => candidate.id)),
                    )
                  }
                >
                  {selectedCandidates.size === preview.candidates.length ? t("Select none") : t("Select all")}
                </button>
              </div>
              {preview.candidates.map((candidate) => (
                <label key={candidate.id} className="skills-candidate">
                  <input
                    type="checkbox"
                    checked={selectedCandidates.has(candidate.id)}
                    onChange={(event) => {
                      setSelectedCandidates((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(candidate.id);
                        else next.delete(candidate.id);
                        return next;
                      });
                    }}
                  />
                  <span>
                    <strong>{candidate.name}</strong>
                    <small>
                      {candidate.description || t("No description.")} · {candidate.files.length}{" "}
                      {t("files")}
                      {candidate.hasScripts ? ` · ${t("scripts")}` : ""}
                    </small>
                  </span>
                </label>
              ))}
              {preview.warnings.map((warning) => (
                <small key={warning} className="skills-candidate-warning">{warning}</small>
              ))}
              {addMessage ? <div className="skills-add-message">{addMessage}</div> : null}
              <div className="skills-add-actions">
                <button
                  className="primary-button"
                  onClick={() => void installSelected()}
                  disabled={installBusy || selectedCandidates.size === 0}
                >
                  {installBusy ? <Loader2 size={12} className="spin" /> : <Plus size={12} />}
                  {t("Install selected")}
                </button>
              </div>
            </div>
          ) : addMessage ? (
            <div className="skills-add-message">{addMessage}</div>
          ) : null}
        </div>
      ) : addMessage ? (
        <div className="skills-add-message">{addMessage}</div>
      ) : null}

      <div className="skills-toolbar">
        <div className="search-box skills-search">
          <Search size={13} className="search-icon" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Filter skills…")}
            spellCheck={false}
          />
        </div>
        <select
          className="settings-select skills-scope-filter"
          value={scope}
          onChange={(event) => setScope(event.target.value as typeof scope)}
        >
          <option value="all">{t("All scopes")}</option>
          <option value="project">{t("Project")}</option>
          <option value="global">{t("Global")}</option>
          <option value="external">{t("External")}</option>
        </select>
      </div>

      {error ? (
        <div className="skills-error">
          <AlertTriangle size={12} /> {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="skills-loading">
          <Loader2 size={15} className="spin" /> {t("Reading skill folders…")}
        </div>
      ) : null}

      {!loading && data && data.skills.length === 0 ? (
        <div className="skills-empty">
          <Sparkles size={18} />
          <strong>{t("No skills found yet")}</strong>
          <p>
            {t(
              "Add a SKILL.md under .cie/skills, .agents/skills, .claude/skills or your global agent skills folder, or install a skill pack from GitHub.",
            )}
          </p>
          <div className="skills-source-list">
            {data.sources.map((source) => (
              <div key={source.id} className={source.exists ? "is-found" : ""}>
                <span>{source.label}</span>
                <code>{source.directory}</code>
                <small>
                  {source.exists
                    ? t("{count} skills", { count: source.skillCount })
                    : t("Folder not created yet")}
                </small>
              </div>
            ))}
          </div>
          <small className="skills-footnote">
            {t(
              "“Folder not created yet” is normal: the folder appears after you add a SKILL.md or install a skill pack. Installed skills are enabled by default and can be switched off from the list.",
            )}
          </small>
        </div>
      ) : null}

      {data && data.skills.length > 0 ? (
        <div className="skills-layout">
          <div className="skills-list">
            {visible.length === 0 ? (
              <div className="skills-filter-empty">{t("No skills match this filter.")}</div>
            ) : (
              visible.map((skill) => (
                <div
                  key={skill.key}
                  role="button"
                  tabIndex={0}
                  className={`skill-card ${selectedKey === skill.key ? "is-active" : ""} ${
                    skill.enabled ? "is-enabled" : ""
                  }`}
                  onClick={() => setSelectedKey(skill.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedKey(skill.key);
                    }
                  }}
                >
                  <label
                    className="skill-toggle"
                    onClick={(event) => event.stopPropagation()}
                    title={skill.enabled ? t("Disable this skill") : t("Enable this skill")}
                  >
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={busyKey === skill.key}
                      onChange={(event) => void toggleSkill(skill, event.target.checked)}
                    />
                    <i className={skill.enabled ? "is-on" : ""} />
                  </label>
                  <div className="skill-card-body">
                    <div className="skill-card-title">
                      <strong>{skill.name}</strong>
                      <span className={`skill-scope is-${skill.scope}`}>{t(skill.scope)}</span>
                      {skill.hasScripts ? (
                        <span className="skill-warning" title={t("Contains scripts; they are not executed.")}>
                          <AlertTriangle size={9} /> {t("scripts")}
                        </span>
                      ) : null}
                    </div>
                    <p>{skill.description || t("No description in SKILL.md.")}</p>
                    <small>
                      {skill.sourceLabel} · {t("{count} files", { count: skill.files.length })} ·{" "}
                      {formatBytes(skill.bytes)}
                    </small>
                  </div>
                </div>
              ))
            )}
          </div>

          <aside className="skills-detail">
            {detailLoading ? (
              <div className="skills-loading">
                <Loader2 size={15} className="spin" /> {t("Loading preview…")}
              </div>
            ) : detail ? (
              <>
                {detailError ? (
                  <div className="skills-error">
                    <AlertTriangle size={12} /> {detailError}
                  </div>
                ) : null}
                <div className="skills-detail-head">
                  <div>
                    <strong>{detail.name}</strong>
                    <span>
                      {detail.sourceLabel} · <code>{detail.directory}</code>
                    </span>
                  </div>
                  <label className="skill-toggle" title={detail.enabled ? t("Disable this skill") : t("Enable this skill")}>
                    <input
                      type="checkbox"
                      checked={detail.enabled}
                      disabled={busyKey === detail.key}
                      onChange={(event) => void toggleSkill(detail, event.target.checked)}
                    />
                    <i className={detail.enabled ? "is-on" : ""} />
                  </label>
                </div>

                <div className="skills-detail-badges">
                  <span className={`skill-scope is-${detail.scope}`}>{t(detail.scope)}</span>
                  {detail.scope !== "external" &&
                  (detail.source === "project-cie" || detail.source === "app-global") ? (
                    <>
                      <button
                        className="ghost-button skills-remove"
                        onClick={() => void updateSkill(detail)}
                        disabled={busyKey === detail.key}
                        title={t("Re-download from the recorded source")}
                      >
                        {busyKey === detail.key ? (
                          <Loader2 size={9} className="spin" />
                        ) : (
                          <RefreshCw size={9} />
                        )}
                        {t("Update")}
                      </button>
                      <button
                        className="ghost-button skills-remove"
                        onClick={() => void removeSkill(detail)}
                        disabled={busyKey === detail.key}
                      >
                        {busyKey === detail.key ? (
                          <Loader2 size={9} className="spin" />
                        ) : (
                          <Trash2 size={9} />
                        )}
                        {t("Remove")}
                      </button>
                    </>
                  ) : null}
                  {detail.allowedTools ? (
                    <span className="skill-tools" title={detail.allowedTools}>
                      {t("tools")}: {detail.allowedTools}
                    </span>
                  ) : null}
                  {detail.hasScripts ? (
                    <span className="skill-warning">
                      <AlertTriangle size={9} /> {t("Contains scripts; not executed")}
                    </span>
                  ) : null}
                </div>

                {detail.warning ? (
                  <div className="skills-warning">
                    <AlertTriangle size={11} /> {detail.warning}
                  </div>
                ) : null}

                <div className="skills-file-tabs">
                  <button
                    className={selectedFile === null ? "is-active" : ""}
                    onClick={() => {
                      setSelectedFile(null);
                      setFileContent(null);
                    }}
                  >
                    <FileText size={10} /> SKILL.md
                  </button>
                  {detail.files
                    .filter((file) => file.path !== "SKILL.md")
                    .map((file) => (
                      <button
                        key={file.path}
                        className={selectedFile === file.path ? "is-active" : ""}
                        onClick={() => void openFile(file.path)}
                        title={`${file.path} · ${formatBytes(file.bytes)}`}
                      >
                        <FolderOpen size={10} /> {file.path}
                      </button>
                    ))}
                </div>

                <pre className="skills-content">
                  {fileLoading
                    ? t("Reading file…")
                    : selectedFile
                      ? fileContent ?? t("No file content.")
                      : detail.body || t("SKILL.md is empty.")}
                </pre>
              </>
            ) : detailError ? (
              <div className="skills-error">
                <AlertTriangle size={12} /> {detailError}
              </div>
            ) : (
              <div className="skills-filter-empty">
                <ShieldCheck size={16} />
                <span>{t("Select a skill to preview it.")}</span>
              </div>
            )}
          </aside>
        </div>
      ) : null}

      <div className="skills-footnote">
        <ShieldCheck size={12} />
        <span>
          {t(
            "Only enabled skills are injected. The agent uses up to {skills} skills, {chars} characters each, and {total} characters total.",
            {
              skills: data?.limits.maxPromptSkills ?? 5,
              chars: data?.limits.maxCharsPerSkill ?? 6000,
              total: data?.limits.maxTotalChars ?? 20000,
            },
          )}
        </span>
      </div>

      {sourcesFound.length > 0 ? (
        <div className="skills-sources-line">
          {sourcesFound.map((source) => (
            <span key={source.id} title={source.directory}>
              {source.label}: {source.skillCount}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
