import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  FileCode2,
  FileText,
  History,
  ListChecks,
  Loader2,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import type { AnalysisResult } from "../../../shared/types";
import type {
  ProjectTask,
  ProjectTaskHistoryEntry,
  ProjectTaskQueue,
} from "../../../shared/tasks";
import type { AiPlanSummary } from "../../../shared/ai";
import type { ProjectBrainView } from "../../../shared/projectBrain";
import type { ProjectDiagnosis, ProjectDiagnosisView } from "../../../shared/diagnosis";
import { api } from "../api";
import { useI18n } from "../i18n";
import { MarkdownText } from "./MarkdownText";
import { TaskQueueCard } from "./TaskQueueCard";

interface ProjectProgressPanelProps {
  analysis: AnalysisResult;
  queue: ProjectTaskQueue | null;
  history?: ProjectTaskHistoryEntry[];
  busy?: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onRetryFailed?: () => void;
  onOpenFile?: (path: string) => void;
  onUpdateTask?: (taskId: string, patch: Partial<ProjectTask>) => void | Promise<void>;
  onDeleteTask?: (taskId: string) => void | Promise<void>;
  onMoveTask?: (taskId: string, direction: "up" | "down") => void | Promise<void>;
  liveStepCount?: number;
}

function formatDate(iso: string | undefined, locale: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale, { day: "2-digit", month: "short" });
}

function toneForStatus(status: ProjectTask["status"]): "done" | "active" | "planned" | "attention" {
  if (status === "done") return "done";
  if (status === "in_progress") return "active";
  if (status === "pending") return "planned";
  return "attention";
}

function plainText(value: string | undefined, max: number): string {
  if (!value) return "";
  const clean = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\s*-]+/gm, " ")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function TaskCard({
  task,
  tone,
  locale,
}: {
  task: ProjectTask;
  tone: "done" | "active" | "planned" | "attention";
  locale: string;
}) {
  const { t } = useI18n();
  const summary = task.status === "done" ? task.resultSummary || task.detail : task.detail;
  const when =
    task.status === "done"
      ? formatDate(task.completedAt ?? task.updatedAt, locale)
      : formatDate(task.startedAt ?? task.updatedAt, locale);
  return (
    <article className={`pp-card is-${tone}`}>
      <div className="pp-card-head">
        <span className="pp-card-dot" />
        <h4 title={task.title}>{task.title}</h4>
      </div>
      {summary ? <p className="pp-card-summary">{plainText(summary, 170)}</p> : null}
      {task.notes ? (
        <div className="pp-card-note">
          <span>{t("Note")}</span>
          {plainText(task.notes, 120)}
        </div>
      ) : null}
      {task.changedFiles.length > 0 ? (
        <div className="pp-card-files">
          <FileCode2 size={10} />
          <span title={task.changedFiles.join(", ")}>
            {task.changedFiles.slice(0, 3).join(", ")}
            {task.changedFiles.length > 3 ? ` +${task.changedFiles.length - 3}` : ""}
          </span>
        </div>
      ) : null}
      <div className="pp-card-meta">
        {task.action ? (
          <span className="pp-chip">
            {task.action}
            {task.surface ? ` · ${task.surface}` : ""}
          </span>
        ) : null}
        {task.verification?.ok ? <span className="pp-chip is-ok">{t("Verified")}</span> : null}
        {task.status === "failed" ? <span className="pp-chip is-bad">{t("Failed")}</span> : null}
        {task.status === "blocked" ? <span className="pp-chip is-warn">{t("Blocked")}</span> : null}
        {when ? (
          <span className="pp-when">
            <Clock size={9} /> {when}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function Lane({
  title,
  hint,
  tone,
  tasks,
  locale,
}: {
  title: string;
  hint: string;
  tone: "done" | "active" | "planned" | "attention";
  tasks: ProjectTask[];
  locale: string;
}) {
  return (
    <section className={`pp-lane is-${tone}`}>
      <header className="pp-lane-head">
        <span className="pp-lane-dot" />
        <div>
          <strong>{title}</strong>
          <small>{hint}</small>
        </div>
        <b>{tasks.length}</b>
      </header>
      <div className="pp-lane-cards">
        {tasks.length === 0 ? (
          <div className="pp-lane-empty">—</div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} tone={tone} locale={locale} />)
        )}
      </div>
    </section>
  );
}

export function ProjectProgressPanel({
  analysis,
  queue,
  history = [],
  busy = false,
  onRefresh,
  onClose,
  onRetryFailed,
  onOpenFile,
  onUpdateTask,
  onDeleteTask,
  onMoveTask,
  liveStepCount = 0,
}: ProjectProgressPanelProps) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<"overview" | "todos" | "plan" | "diagnosis" | "brain">("overview");
  const [brain, setBrain] = useState<ProjectBrainView | null>(null);
  const [brainBusy, setBrainBusy] = useState(false);
  const [brainError, setBrainError] = useState<string | null>(null);
  const [diagnosisView, setDiagnosisView] = useState<ProjectDiagnosisView | null>(null);
  const [diagnosisBusy, setDiagnosisBusy] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [plans, setPlans] = useState<AiPlanSummary[]>([]);
  const [planName, setPlanName] = useState("");
  const [planContent, setPlanContent] = useState("");
  const [planBusy, setPlanBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPlanBusy(true);
    void api.plans
      .list(analysis.id)
      .then(async (result) => {
        if (cancelled) return;
        setPlans(result.plans);
        const latest = result.plans[0];
        setPlanName(latest?.name ?? "");
        if (latest) {
          const plan = await api.plans.get(analysis.id, latest.name).catch(() => null);
          if (!cancelled) setPlanContent(plan?.content ?? "");
        } else {
          setPlanContent("");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPlans([]);
          setPlanContent("");
        }
      })
      .finally(() => {
        if (!cancelled) setPlanBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [analysis.id]);
  useEffect(() => {
    if (tab !== "brain" || brain) return;
    let cancelled = false;
    setBrainBusy(true);
    setBrainError(null);
    void api.projectBrain(analysis.id)
      .then((result) => {
        if (!cancelled) setBrain(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBrainError(error instanceof Error ? error.message : t("Could not load the project brain."));
        }
      })
      .finally(() => {
        setBrainBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // `t` is intentionally omitted: a locale change must not cancel an in-flight
    // brain request. `brainBusy` must also stay out of the deps, otherwise the
    // cleanup cancels the request as soon as the spinner starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.id, tab, brain]);
  async function refreshBrain() {
    if (brainBusy) return;
    setBrainBusy(true);
    setBrainError(null);
    try {
      setBrain(await api.refreshProjectBrain(analysis.id));
    } catch (error) {
      setBrainError(error instanceof Error ? error.message : t("Could not refresh the project brain."));
    } finally {
      setBrainBusy(false);
    }
  }
  useEffect(() => {
    if (tab !== "diagnosis" || diagnosisView) return;
    let cancelled = false;
    setDiagnosisBusy(true);
    setDiagnosisError(null);
    void api.projectDiagnosis(analysis.id)
      .then((result) => {
        if (!cancelled) setDiagnosisView(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDiagnosisError(error instanceof Error ? error.message : t("Could not load the diagnosis."));
        }
      })
      .finally(() => {
        setDiagnosisBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // `t` is intentionally omitted so a locale change does not cancel the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.id, tab, diagnosisView]);
  async function runDiagnosis() {
    if (diagnosisBusy || !queue?.goal) return;
    setDiagnosisBusy(true);
    setDiagnosisError(null);
    try {
      setDiagnosisView(await api.runProjectDiagnosis(analysis.id, queue.goal));
    } catch (error) {
      setDiagnosisError(error instanceof Error ? error.message : t("Could not run the diagnosis."));
    } finally {
      setDiagnosisBusy(false);
    }
  }
  const diagnosisData =
    [queue?.diagnosis, diagnosisView?.diagnosis]
      .filter((item): item is ProjectDiagnosis => Boolean(item))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1) ?? null;
  const tasks = queue?.tasks ?? [];
  const { done, active, planned, attention } = useMemo(() => {
    const sortDone = (a: ProjectTask, b: ProjectTask) =>
      (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt);
    const sortPlanned = (a: ProjectTask, b: ProjectTask) => a.createdAt.localeCompare(b.createdAt);
    return {
      done: [...tasks].filter((task) => task.status === "done").sort(sortDone),
      active: [...tasks].filter((task) => task.status === "in_progress"),
      planned: [...tasks].filter((task) => task.status === "pending").sort(sortPlanned),
      attention: [...tasks].filter(
        (task) => task.status === "failed" || task.status === "blocked",
      ),
    };
  }, [tasks]);

  const total = tasks.length;
  const percent = total === 0 ? 0 : Math.round((done.length / total) * 100);
  const languages = Object.keys(analysis.languages ?? {})
    .slice(0, 3)
    .join(" · ");
  const lastUpdate = queue?.updatedAt ? new Date(queue.updatedAt) : null;

  return (
    <div className="project-progress">
      <div className="pp-head">
        <div className="pp-head-main">
          <span className="pp-eyebrow">
            <Network size={10} /> {t("Project progress")}
          </span>
          <h3>{analysis.projectName}</h3>
          <p>{queue?.goal ? plainText(queue.goal, 140) : t("No goal recorded for this project yet.")}</p>
        </div>
        <div className="pp-head-actions">
          <button onClick={onRefresh} disabled={busy} title={t("Refresh")}>
            {busy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
          </button>
          <button onClick={onClose} title={t("Close")}>
            <X size={11} />
          </button>
        </div>
      </div>

      <div className="pp-tabs" role="tablist">
        <button
          className={tab === "overview" ? "is-active" : ""}
          onClick={() => setTab("overview")}
          role="tab"
          aria-selected={tab === "overview"}
        >
          <Network size={10} /> {t("Overview")}
        </button>
        <button
          className={tab === "todos" ? "is-active" : ""}
          onClick={() => setTab("todos")}
          role="tab"
          aria-selected={tab === "todos"}
        >
          <ListChecks size={10} /> {t("Todos")}
          {total > 0 ? <b>{done.length}/{total}</b> : null}
        </button>
        <button
          className={tab === "plan" ? "is-active" : ""}
          onClick={() => setTab("plan")}
          role="tab"
          aria-selected={tab === "plan"}
        >
          <FileText size={10} /> {t("Plan")}
        </button>
        <button
          className={tab === "diagnosis" ? "is-active" : ""}
          onClick={() => setTab("diagnosis")}
          role="tab"
          aria-selected={tab === "diagnosis"}
        >
          <Sparkles size={10} /> {t("Diagnosis")}
        </button>
        <button
          className={tab === "brain" ? "is-active" : ""}
          onClick={() => setTab("brain")}
          role="tab"
          aria-selected={tab === "brain"}
        >
          <Brain size={10} /> {t("Project brain")}
        </button>
      </div>

      {tab === "overview" ? (
        <>
      {total === 0 ? (
        <div className="pp-empty">
          <div className="pp-empty-head">
            <CheckCircle2 size={16} />
            <div>
              <strong>{t("Nothing recorded yet")}</strong>
              <span>{t("Tasks and completed work will show up here.")}</span>
            </div>
          </div>
          <div className="pp-facts">
            <div>
              <b>{analysis.files.length}</b>
              <span>{t("files")}</span>
            </div>
            <div>
              <b>{analysis.stats.symbols}</b>
              <span>{t("symbols")}</span>
            </div>
            <div>
              <b>{analysis.stats.edges}</b>
              <span>{t("relationships")}</span>
            </div>
            {languages ? (
              <div>
                <b className="is-text">{languages}</b>
                <span>{t("language")}</span>
              </div>
            ) : null}
          </div>
          <button className="pp-open-queue" onClick={() => setTab("todos")}>
            <ListChecks size={11} /> {t("Open todos")}
          </button>
        </div>
      ) : (
        <>
          <div className="pp-summary">
            <div className="pp-gauge" style={{ ["--pct" as string]: `${percent}%` }}>
              <b>{percent}%</b>
              <span>{t("done")}</span>
            </div>
            <div className="pp-summary-facts">
              <div>
                <b>{done.length}</b>
                <span>{t("done")}</span>
              </div>
              <div>
                <b>{active.length}</b>
                <span>{t("Active")}</span>
              </div>
              <div>
                <b>{planned.length}</b>
                <span>{t("planned")}</span>
              </div>
              {attention.length > 0 ? (
                <div className="is-bad">
                  <b>{attention.length}</b>
                  <span>{t("needs attention")}</span>
                </div>
              ) : null}
            </div>
            <div className="pp-summary-meta">
              <span>
                {queue?.status === "running" ? <Loader2 size={9} className="spin" /> : null}
                {t("Queue")}: {queue?.status ?? "—"}
              </span>
              {lastUpdate ? (
                <span>
                  <Clock size={9} /> {lastUpdate.toLocaleString(locale)}
                </span>
              ) : null}
            </div>
          </div>

          <div className="pp-board">
            <Lane
              title={t("Planned")}
              hint={t("Next up")}
              tone="planned"
              tasks={planned}
              locale={locale}
            />
            <Lane
              title={t("In progress")}
              hint={t("Running now")}
              tone="active"
              tasks={active}
              locale={locale}
            />
            <Lane
              title={t("Done")}
              hint={t("Completed work")}
              tone="done"
              tasks={done}
              locale={locale}
            />
            {attention.length > 0 ? (
              <Lane
                title={t("Needs attention")}
                hint={t("Failed or blocked")}
                tone="attention"
                tasks={attention}
                locale={locale}
              />
            ) : null}
          </div>

          {queue?.planMeta?.assumptions?.length ? (
            <div className="pp-assumptions">
              <span>{t("Assumptions")}</span>
              {queue.planMeta.assumptions.slice(0, 4).map((item) => (
                <em key={item}>{plainText(item, 120)}</em>
              ))}
            </div>
          ) : null}
        </>
      )}

      {history.length > 0 ? (
        <div className="pp-history">
          <div className="pp-history-title">
            <History size={10} /> {t("Earlier work")}
          </div>
          {history.map((entry) => {
            const doneCount = entry.tasks.filter((task) => task.status === "done").length;
            return (
              <details
                key={`${entry.goal}-${entry.updatedAt}`}
                className="pp-history-group"
              >
                <summary>
                  <span className="pp-history-goal" title={entry.goal}>
                    {plainText(entry.goal, 80) || t("Untitled goal")}
                  </span>
                  <span className="pp-history-meta">
                    {doneCount}/{entry.tasks.length} · {formatDate(entry.updatedAt, locale)}
                  </span>
                </summary>
                <div className="pp-history-cards">
                  {entry.tasks.map((task) => (
                    <TaskCard
                      key={`${entry.updatedAt}-${task.id}`}
                      task={task}
                      tone={toneForStatus(task.status)}
                      locale={locale}
                    />
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      ) : null}
        </>
      ) : tab === "todos" ? (
        <div className="pp-todos">
          {queue && tasks.length > 0 ? (
            <TaskQueueCard
              queue={queue}
              flat
              liveStepCount={liveStepCount}
              onOpenFile={onOpenFile}
              onRetryFailed={onRetryFailed}
              onUpdateTask={onUpdateTask}
              onDeleteTask={onDeleteTask}
              onMoveTask={onMoveTask}
            />
          ) : (
            <div className="pp-todos-empty">
              <ListChecks size={17} />
              <strong>{t("No AI todos yet")}</strong>
              <span>{t("Start a job in Chat; planned and completed tasks appear here.")}</span>
            </div>
          )}
        </div>
      ) : tab === "diagnosis" ? (
        <div className="pp-diagnosis">
          {diagnosisError ? (
            <div className="pp-brain-error">
              <AlertTriangle size={12} />
              <span>{diagnosisError}</span>
            </div>
          ) : null}
          {diagnosisData ? (
            (() => {
              const diagnosis: ProjectDiagnosis = diagnosisData;
              return (
                <>
                  <div className="pp-diag-head">
                    <div>
                      <span className="pp-eyebrow">
                        <Sparkles size={10} /> {t("Diagnosis")}
                      </span>
                      <p>{t("Read-only root-cause and design analysis generated before planning.")}</p>
                    </div>
                    <div className="pp-diag-head-actions">
                      <button
                        type="button"
                        onClick={() => void runDiagnosis()}
                        disabled={diagnosisBusy || !queue?.goal}
                        title={t("Run the diagnosis again")}
                      >
                        {diagnosisBusy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                      </button>
                      <span className={`pp-diag-confidence ${diagnosis.confidence < 0.5 ? "is-low" : ""}`}>
                        {Math.round(diagnosis.confidence * 100)}%
                      </span>
                    </div>
                  </div>

                  <section className="pp-diag-problem">
                    <h4>{t("Problem")}</h4>
                    <p>{plainText(diagnosis.problem, 500)}</p>
                    <h4>{t("Root cause")}</h4>
                    <p>{plainText(diagnosis.rootCause, 900)}</p>
                  </section>

                  {diagnosis.facts.length > 0 ? (
                    <section className="pp-diag-section">
                      <h4>
                        <FileCode2 size={11} /> {t("Facts")}
                      </h4>
                      {diagnosis.facts.slice(0, 8).map((fact, index) => (
                        <div className="pp-diag-fact" key={`${fact.claim}-${index}`}>
                          <b>{plainText(fact.claim, 220)}</b>
                          {fact.file ? (
                            <button
                              type="button"
                              className="pp-diag-file"
                              onClick={() => onOpenFile?.(fact.file!)}
                              title={fact.file}
                            >
                              {fact.file}
                              {fact.line ? `:${fact.line}` : ""}
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </section>
                  ) : null}

                  {diagnosis.constraints.length > 0 || diagnosis.unknowns.length > 0 ? (
                    <section className="pp-diag-section">
                      <h4>
                        <ShieldCheck size={11} /> {t("Constraints & unknowns")}
                      </h4>
                      {diagnosis.constraints.map((constraint) => (
                        <div className="pp-diag-line" key={constraint}>
                          <span className="pp-chip">{t("constraint")}</span>
                          <b>{plainText(constraint, 160)}</b>
                        </div>
                      ))}
                      {diagnosis.unknowns.map((unknown) => (
                        <div className="pp-diag-line" key={unknown}>
                          <span className="pp-chip is-warn">{t("unknown")}</span>
                          <b>{plainText(unknown, 180)}</b>
                        </div>
                      ))}
                    </section>
                  ) : null}

                  {diagnosis.designs.length > 0 ? (
                    <section className="pp-diag-section">
                      <h4>
                        <Network size={11} /> {t("Designs")}
                      </h4>
                      {diagnosis.designs.map((design) => {
                        const chosen = design.name === diagnosis.chosenDesign;
                        return (
                          <div className={`pp-diag-design ${chosen ? "is-chosen" : ""}`} key={design.name}>
                            <div className="pp-diag-design-head">
                              <b>{design.name}</b>
                              <span className={`pp-chip ${chosen ? "is-ok" : ""}`}>
                                {chosen ? t("chosen") : design.risk}
                              </span>
                            </div>
                            <p>{plainText(design.summary, 300)}</p>
                            {design.pros.length > 0 ? <small>+ {design.pros.join(" · ")}</small> : null}
                            {design.cons.length > 0 ? <small>− {design.cons.join(" · ")}</small> : null}
                          </div>
                        );
                      })}
                      {diagnosis.rationale ? (
                        <p className="pp-diag-rationale">
                          <b>{t("Why:")}</b> {plainText(diagnosis.rationale, 400)}
                        </p>
                      ) : null}
                    </section>
                  ) : null}

                  {diagnosis.callSites.length > 0 || diagnosis.includes.length > 0 || diagnosis.impact.length > 0 ? (
                    <section className="pp-diag-section">
                      <h4>
                        <Wrench size={11} /> {t("Call sites & impact")}
                      </h4>
                      {[...diagnosis.callSites, ...diagnosis.includes, ...diagnosis.impact].slice(0, 10).map((item) => (
                        <small className="pp-diag-mono" key={item}>
                          {plainText(item, 180)}
                        </small>
                      ))}
                    </section>
                  ) : null}

                  {diagnosis.failureModes.length > 0 || diagnosis.rollback ? (
                    <section className="pp-diag-section">
                      <h4>
                        <AlertTriangle size={11} /> {t("Failure modes & rollback")}
                      </h4>
                      {diagnosis.failureModes.slice(0, 6).map((mode) => (
                        <div className="pp-diag-failure" key={mode.scenario}>
                          <b>{plainText(mode.scenario, 180)}</b>
                          <small>{plainText(mode.impact, 160)}</small>
                          <small className="is-fix">→ {plainText(mode.mitigation, 180)}</small>
                        </div>
                      ))}
                      {diagnosis.rollback ? (
                        <p className="pp-diag-rollback">
                          <b>{t("Rollback:")}</b> {plainText(diagnosis.rollback, 300)}
                        </p>
                      ) : null}
                    </section>
                  ) : null}

                  <section className="pp-diag-section">
                    <h4>
                      <CheckCircle2 size={11} /> {t("Verification")}
                    </h4>
                    {diagnosis.verification.command ? (
                      <code className="pp-brain-command">{diagnosis.verification.command}</code>
                    ) : null}
                    {diagnosis.verification.checks.map((check) => (
                      <small className="pp-diag-check" key={check}>
                        {plainText(check, 200)}
                      </small>
                    ))}
                    {diagnosis.verification.expected.map((expected) => (
                      <small className="pp-diag-mono" key={expected}>
                        → {plainText(expected, 180)}
                      </small>
                    ))}
                  </section>

                  {diagnosis.todos.length > 0 ? (
                    <section className="pp-diag-section">
                      <h4>
                        <ListChecks size={11} /> {t("Todos")}
                      </h4>
                      {diagnosis.todos.map((todo) => (
                        <div className="pp-diag-line" key={todo}>
                          <span className="pp-card-dot" />
                          <b>{plainText(todo, 180)}</b>
                        </div>
                      ))}
                    </section>
                  ) : null}

                  <div className="pp-diag-meta">
                    <span>{diagnosis.provider ?? "—"}/{diagnosis.model ?? "—"}</span>
                    <span>{diagnosis.tokenUsage?.totalTokens?.toLocaleString() ?? 0} tokens</span>
                    <span>{formatDate(diagnosis.createdAt, locale)}</span>
                  </div>
                </>
              );
            })()
          ) : (
            <div className="pp-todos-empty">
              <Sparkles size={17} />
              <strong>{diagnosisBusy ? t("Running diagnosis…") : t("No diagnosis yet")}</strong>
              <span>{t("Run a build task; the read-only diagnosis appears here before planning.")}</span>
              {queue?.goal ? (
                <button className="pp-open-queue" onClick={() => void runDiagnosis()} disabled={diagnosisBusy}>
                  {diagnosisBusy ? <Loader2 size={11} className="spin" /> : <Sparkles size={11} />} {t("Run diagnosis")}
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : tab === "brain" ? (
        <div className="pp-brain">
          <div className="pp-brain-head">
            <div>
              <span className="pp-eyebrow">
                <Brain size={10} /> {t("Project brain")}
              </span>
              <p>{t("Persistent project memory; every task and chat starts with this brief instead of rediscovering the project.")}</p>
            </div>
            <button onClick={() => void refreshBrain()} disabled={brainBusy} title={t("Refresh project brain")}>
              {brainBusy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
            </button>
          </div>
          {brainError ? (
            <div className="pp-brain-error">
              <AlertTriangle size={12} />
              <span>{brainError}</span>
            </div>
          ) : null}
          {!brain && brainBusy ? (
            <div className="pp-todos-empty">
              <Loader2 size={17} className="spin" />
              <strong>{t("Loading project memory…")}</strong>
            </div>
          ) : null}
          {brain ? (
            <>
              <div className="pp-brain-identity">
                <div>
                  <span>{t("Kind")}</span>
                  <b>{brain.brain.identity.kind}</b>
                </div>
                <div>
                  <span>{t("Stack")}</span>
                  <b>{brain.brain.identity.stack.slice(0, 4).join(" · ") || "—"}</b>
                </div>
                <div>
                  <span>{t("Entry points")}</span>
                  <b title={brain.brain.identity.entryPoints.join(", ")}>
                    {brain.brain.identity.entryPoints.slice(0, 3).join(" · ") || "—"}
                  </b>
                </div>
                <div>
                  <span>{t("Updated")}</span>
                  <b>{formatDate(brain.brain.updatedAt, locale)}</b>
                </div>
              </div>

              <div className="pp-brain-grid">
                <section>
                  <h4>
                    <Network size={11} /> {t("Architecture")}
                  </h4>
                  <p>{plainText(brain.brain.architecture.summary, 260)}</p>
                  {brain.brain.architecture.modules.slice(0, 5).map((module) => (
                    <div className="pp-brain-line" key={`${module.name}-${module.role}`}>
                      <b>{module.name}</b>
                      <span>{module.role}</span>
                      <small title={module.files.join(", ")}>{module.files.slice(0, 3).join(", ")}</small>
                    </div>
                  ))}
                  {brain.brain.architecture.routes.length > 0 ? (
                    <div className="pp-brain-sub">
                      <span>{t("Routes")}</span>
                      {brain.brain.architecture.routes.slice(0, 6).map((route) => (
                        <small key={`${route.label}-${route.filePath ?? ""}`}>
                          {route.label}
                          {route.filePath ? ` — ${route.filePath}` : ""}
                        </small>
                      ))}
                    </div>
                  ) : null}
                </section>

                <section>
                  <h4>
                    <FileCode2 size={11} /> {t("Key files")}
                  </h4>
                  {brain.brain.inventory.files.slice(0, 10).map((file) => (
                    <button
                      type="button"
                      className="pp-brain-file"
                      key={file.path}
                      onClick={() => onOpenFile?.(file.path)}
                      title={`${file.role} · ${file.loc} lines · ${file.symbols} symbols`}
                    >
                      <span>{file.path}</span>
                      <small>{file.role}</small>
                    </button>
                  ))}
                </section>

                <section>
                  <h4>
                    <CheckCircle2 size={11} /> {t("Features")}
                  </h4>
                  {brain.brain.features.length === 0 ? (
                    <p className="pp-brain-muted">{t("No completed work recorded yet.")}</p>
                  ) : (
                    brain.brain.features.slice(0, 8).map((feature) => (
                      <div className={`pp-brain-feature is-${feature.status}`} key={feature.id}>
                        <span className="pp-chip">{feature.status}</span>
                        <b>{plainText(feature.name, 90)}</b>
                        {feature.files.length > 0 ? (
                          <small title={feature.files.join(", ")}>{feature.files.slice(0, 2).join(", ")}</small>
                        ) : null}
                      </div>
                    ))
                  )}
                </section>

                <section>
                  <h4>
                    <ShieldCheck size={11} /> {t("Constraints")}
                  </h4>
                  {brain.brain.constraints.length === 0 ? (
                    <p className="pp-brain-muted">{t("No explicit constraints recorded.")}</p>
                  ) : (
                    brain.brain.constraints.slice(0, 6).map((constraint) => (
                      <div className="pp-brain-line" key={constraint.id}>
                        <span className="pp-chip">{constraint.kind}</span>
                        <b>{plainText(constraint.text, 120)}</b>
                      </div>
                    ))
                  )}
                  {brain.brain.knownIssues.length > 0 ? (
                    <div className="pp-brain-sub">
                      <span>{t("Known issues")}</span>
                      {brain.brain.knownIssues.slice(0, 4).map((issue) => (
                        <small key={issue.text}>{plainText(issue.text, 140)}</small>
                      ))}
                    </div>
                  ) : null}
                </section>

                <section>
                  <h4>
                    <History size={11} /> {t("Recent changes")}
                  </h4>
                  {brain.brain.recentChanges.length === 0 ? (
                    <p className="pp-brain-muted">{t("No recent changes recorded.")}</p>
                  ) : (
                    brain.brain.recentChanges.slice(0, 6).map((change) => (
                      <div className="pp-brain-change" key={`${change.at}-${change.taskId ?? change.summary.slice(0, 20)}`}>
                        <small>{formatDate(change.at, locale)}</small>
                        <b>{plainText(change.summary, 140)}</b>
                        {change.files.length > 0 ? (
                          <span title={change.files.join(", ")}>{change.files.slice(0, 3).join(", ")}</span>
                        ) : null}
                      </div>
                    ))
                  )}
                </section>

                <section>
                  <h4>
                    <Wrench size={11} /> {t("Verification")}
                  </h4>
                  {brain.brain.verification.commands.map((command) => (
                    <code className="pp-brain-command" key={command}>
                      {command}
                    </code>
                  ))}
                  {brain.brain.verification.checks.slice(0, 4).map((check) => (
                    <small className="pp-brain-check" key={check}>
                      {check}
                    </small>
                  ))}
                </section>
              </div>

              <details className="pp-brain-brief">
                <summary>
                  <Sparkles size={10} /> {t("Memory brief used in prompts")}
                </summary>
                <pre>{brain.brief}</pre>
              </details>
            </>
          ) : null}
        </div>
      ) : (
        <div className="pp-plan">
          {plans.length > 0 ? (
            <>
              <select
                value={planName}
                disabled={planBusy}
                onChange={(event) => {
                  const name = event.target.value;
                  setPlanName(name);
                  setPlanBusy(true);
                  void api.plans
                    .get(analysis.id, name)
                    .then((plan) => setPlanContent(plan.content))
                    .catch(() => setPlanContent(""))
                    .finally(() => setPlanBusy(false));
                }}
              >
                {plans.map((plan) => (
                  <option key={plan.name} value={plan.name}>
                    {plan.title}
                  </option>
                ))}
              </select>
              {planContent ? (
                <MarkdownText value={planContent} />
              ) : (
                <div className="pp-todos-empty">
                  <FileText size={17} />
                  <strong>{planBusy ? t("Loading…") : t("No plan content")}</strong>
                </div>
              )}
            </>
          ) : (
            <div className="pp-todos-empty">
              <FileText size={17} />
              <strong>{t("No saved plan yet")}</strong>
              <span>{t("Use Plan mode to inspect the project and save a plan.")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
