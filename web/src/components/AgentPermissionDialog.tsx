import {
  AlertTriangle,
  Check,
  CheckCheck,
  FileCode2,
  Loader2,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type { AiAgentPermissionRequest, AiPermissionDecision } from "../../../shared/ai";
import { useI18n } from "../i18n";

interface AgentPermissionDialogProps {
  request: AiAgentPermissionRequest | null;
  busy: boolean;
  onDecide: (decision: AiPermissionDecision) => void;
}

export function AgentPermissionDialog({ request, busy, onDecide }: AgentPermissionDialogProps) {
  const { t } = useI18n();
  if (!request) return null;

  const isWrite = request.kind === "write";
  const title = request.destructive
    ? t("Confirm destructive action")
    : isWrite
      ? t("Allow this file change?")
      : t("Allow this command?");

  return (
    <div className="modal-backdrop agent-permission-backdrop">
      <div className="agent-permission-modal" role="dialog" aria-modal="true">
        <div className="agent-permission-head">
          <span className={`agent-permission-icon ${isWrite ? "is-write" : "is-command"}`}>
            {isWrite ? <FileCode2 size={17} /> : <Terminal size={17} />}
          </span>
          <div className="agent-permission-title">
            <div className="modal-eyebrow">
              <ShieldCheck size={11} /> {t("Agent needs permission")}
            </div>
            <h2>{title}</h2>
          </div>
        </div>

        <div className="agent-permission-meta">
          <span>{request.tool}</span>
          {request.target ? <code>{request.target}</code> : null}
        </div>

        {request.detail ? <p className="agent-permission-detail">{request.detail}</p> : null}

        {request.preview ? (
          <pre className="agent-permission-preview">{request.preview}</pre>
        ) : null}

        {request.destructive ? (
          <div className="agent-permission-warning">
            <AlertTriangle size={13} />
            <span>{t("This action cannot be undone. It is never remembered, so the agent must ask every time.")}</span>
          </div>
        ) : (
          <p className="agent-permission-note">
            {t("“Always allow” approves this action type for the rest of this run and enables the matching pre-approval toggle.")}
          </p>
        )}

        <div className="agent-permission-actions">
          <button className="ghost-button" onClick={() => onDecide("deny")} disabled={busy}>
            <X size={13} /> {t("Deny")}
          </button>
          <span className="modal-spacer" />
          {request.canAlways ? (
            <button className="ghost-button" onClick={() => onDecide("always")} disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" /> : <CheckCheck size={13} />}
              {t("Always allow")}
            </button>
          ) : null}
          <button className="primary-button" onClick={() => onDecide("once")} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
            {t("Allow once")}
          </button>
        </div>
      </div>
    </div>
  );
}
