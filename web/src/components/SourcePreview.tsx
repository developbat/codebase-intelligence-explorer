import { useEffect, useRef, useState } from "react";
import { Highlight, type PrismTheme } from "prism-react-renderer";
import { AlertTriangle, FileCode2, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { api, type SourceResponse } from "../api";
import { useI18n } from "../i18n";

const theme: PrismTheme = {
  plain: { color: "#c8d6ea", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "#5d718c", fontStyle: "italic" } },
    { types: ["punctuation"], style: { color: "#8ba0ba" } },
    { types: ["namespace"], style: { opacity: 0.85 } },
    { types: ["property", "tag", "constant", "symbol", "deleted"], style: { color: "#f08d9b" } },
    { types: ["boolean", "number"], style: { color: "#f3b968" } },
    { types: ["selector", "attr-name", "string", "char", "builtin", "inserted"], style: { color: "#8fd6a4" } },
    { types: ["operator", "entity", "url", "string"], style: { color: "#93c5fd" } },
    { types: ["atrule", "attr-value", "keyword"], style: { color: "#c4a7f5" } },
    { types: ["function", "class-name"], style: { color: "#7dd3fc" } },
    { types: ["regex", "important", "variable"], style: { color: "#f9c982" } },
  ],
};

function prismLanguage(language: string): string {
  if (language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx") {
    return language;
  }
  return "typescript";
}

interface SourcePreviewProps {
  analysisId: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export function SourcePreview({ analysisId, filePath, startLine, endLine }: SourcePreviewProps) {
  const { t } = useI18n();
  const [data, setData] = useState<SourceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(false);
  }, [filePath, analysisId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const from = expanded ? 1 : Math.max(1, (startLine ?? 1) - 8);
    const to = expanded ? 99999 : Math.max(from + 20, (endLine ?? startLine ?? 1) + 10);
    api
      .source(analysisId, filePath, from, to)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setLoading(false);
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        setError(requestError instanceof Error ? requestError.message : t("Source code could not be read"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, filePath, startLine, endLine, expanded]);

  useEffect(() => {
    if (!data || !scrollRef.current) return;
    const element = scrollRef.current.querySelector<HTMLElement>(".code-line.is-highlighted");
    if (!element) return;
    const container = scrollRef.current;
    const top = element.offsetTop - container.clientHeight / 2 + element.clientHeight / 2;
    container.scrollTop = Math.max(0, top);
  }, [data]);

  if (error) {
    return (
      <div className="source-error">
        <AlertTriangle size={14} /> {error}
      </div>
    );
  }

  return (
    <div className="source-preview">
      <div className="source-header">
        <span className="source-title" title={filePath}>
          <FileCode2 size={13} />
          {filePath.split("/").pop()}
        </span>
        <span className="source-range">
          {data ? `${data.startLine}–${data.endLine} / ${data.totalLines}` : "…"}
        </span>
        <button
          className="icon-button subtle"
          title={expanded ? t("Back to symbol") : t("Show full file")}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      </div>
      <div className="source-scroll" ref={scrollRef}>
        {loading && !data ? (
          <div className="source-loading">
            <Loader2 size={14} className="spin" /> {t("Source code loading…")}
          </div>
        ) : null}
        {data ? (
          <Highlight theme={theme} code={data.lines.map((line) => line.text).join("\n")} language={prismLanguage(data.language)}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre className="code-block">
                {tokens.map((line, index) => {
                  const lineNumber = data.startLine + index;
                  const highlighted =
                    startLine !== undefined &&
                    endLine !== undefined &&
                    lineNumber >= startLine &&
                    lineNumber <= endLine;
                  return (
                    <div
                      key={lineNumber}
                      {...getLineProps({ line })}
                      className={`code-line ${highlighted ? "is-highlighted" : ""}`}
                    >
                      <span className="code-line-number">{lineNumber}</span>
                      <span className="code-line-content">
                        {line.map((token, tokenIndex) => (
                          <span key={tokenIndex} {...getTokenProps({ token })} />
                        ))}
                      </span>
                    </div>
                  );
                })}
              </pre>
            )}
          </Highlight>
        ) : null}
      </div>
    </div>
  );
}
