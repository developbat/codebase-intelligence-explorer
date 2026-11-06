import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { LANGUAGE_COLOR } from "../lib/constants";

interface ProjectIconProps {
  id: string;
  name: string;
  version?: string;
  languages?: Record<string, number>;
  frameworks?: string[];
  size?: "sm" | "md" | "lg";
}

function primaryLanguage(languages: Record<string, number> | undefined): string {
  if (!languages) return "other";
  return (
    Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .map(([language]) => language)[0] ?? "other"
  );
}

export function ProjectIcon({
  id,
  name,
  version,
  languages,
  frameworks,
  size = "md",
}: ProjectIconProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [id, version]);

  const language = useMemo(() => primaryLanguage(languages), [languages]);
  const color = LANGUAGE_COLOR[language] ?? "#a78bfa";
  const initial = (name.trim().match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  const title = frameworks && frameworks.length > 0 ? frameworks.join(", ") : language;

  return (
    <span
      className={`project-icon project-icon-${size}`}
      style={{ "--project-color": color } as React.CSSProperties}
      title={title}
    >
      <span className="project-icon-fallback">{initial}</span>
      {!failed ? (
        <img
          src={api.projectIconUrl(id, version)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}
