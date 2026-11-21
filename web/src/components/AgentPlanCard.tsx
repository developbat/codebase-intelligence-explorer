import { Files, ListChecks, ShieldAlert, ShieldCheck, Terminal } from "lucide-react";
import type { AiAgentPlan } from "../../../shared/ai";
import { useI18n } from "../i18n";

interface AgentPlanCardProps {
  plan: AiAgentPlan;
  allowWrite: boolean;
  allowCommands: boolean;
  defaultOpen?: boolean;
}

export function AgentPlanCard({
  plan,
  allowWrite,
  allowCommands,
  defaultOpen = false,
}: AgentPlanCardProps) {
  const { t } = useI18n();
  const writeState = !plan.needsWrite
    ? t("not needed")
    : allowWrite
      ? t("pre-approved")
      : t("will ask");
  const commandState = !plan.needsCommand
    ? t("not needed")
    : allowCommands
      ? t("pre-approved")
      : t("will ask");
  const summary =
    plan.intent === "question" || plan.intent === "explain"
      ? t("Answer from {count} likely files and the project index.", { count: plan.scope.length })
      : plan.intent === "run"
        ? t("Inspect the project, run the requested command with permission, and report the output.")
        : plan.intent === "scaffold"
          ? t("Create the project skeleton, wire dependencies, and verify the build.")
          : t("Inspect {count} likely files, apply scoped edits, and verify the result.", {
              count: plan.scope.length,
            });

  return (
    <details className={`agent-plan is-${plan.risk}`} open={defaultOpen}>
      <summary>
        <span className="agent-plan-title">
          <ListChecks size={12} /> {t("Plan")}
        </span>
        <span className="agent-plan-intent">{t(plan.intent)}</span>
        <span className={`agent-plan-risk is-${plan.risk}`}>
          {plan.risk === "high" ? <ShieldAlert size={10} /> : <ShieldCheck size={10} />}
          {t(plan.risk)} {t("risk")}
        </span>
        <small>
          {plan.steps.length} {t("steps")}
        </small>
      </summary>
      <div className="agent-plan-body">
        <p>{summary}</p>
        <div className="agent-plan-meta">
          <span>
            <Files size={10} /> {plan.scope.length} {t("files")}
          </span>
          <span>{t("Writes")}: {writeState}</span>
          <span>{t("Commands")}: {commandState}</span>
          {plan.verification ? (
            <span className="is-verify">
              <Terminal size={10} /> {plan.verification}
            </span>
          ) : null}
        </div>
        {plan.scope.length > 0 ? (
          <div className="agent-plan-scope">
            {plan.scope.map((filePath) => (
              <code key={filePath} title={filePath}>
                {filePath}
              </code>
            ))}
          </div>
        ) : null}
        <ol className="agent-plan-steps">
          {plan.steps.map((step) => (
            <li key={step.label}>
              <strong>{t(step.label)}</strong>
              {step.detail ? <small>{step.detail}</small> : null}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
