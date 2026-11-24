import { useMemo, useState } from "react";
import { Check, Copy, Download, FileCode2, Table2 } from "lucide-react";
import type { ExtractionTable } from "../../../shared/extraction";
import {
  extractionToCsv,
  extractionToMarkdown,
} from "../../../shared/extraction";
import { useI18n } from "../i18n";

const KIND_LABELS: Record<string, string> = {
  color: "Colors",
  input: "Inputs",
  button: "Buttons",
  link: "Links",
  function: "Functions",
  class: "Classes",
  component: "Components",
  env: "Environment variables",
  todo: "TODOs",
  route: "Routes",
  import: "Imports",
  selector: "Selectors",
  asset: "Assets",
  document: "Documents",
  markdown: "Markdown",
  file: "Files",
  text: "Text matches",
};

const HEADER_LABELS: Record<string, string> = {
  file: "File",
  line: "Line",
  name: "Name",
  type: "Type",
  text: "Text",
  href: "Link",
  selector: "Selector",
  property: "Property",
  color: "Color",
  bytes: "Size",
  extension: "Extension",
  loc: "Lines",
  value: "Value",
  method: "Method",
  path: "Path",
  placeholder: "Placeholder",
};

const PAGE_SIZE = 50;

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

interface ExtractionTableProps {
  table: ExtractionTable;
  onOpenFile?: (path: string, line?: number) => void;
}

export function ExtractionTableView({ table, onOpenFile }: ExtractionTableProps) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState<"csv" | "markdown" | null>(null);
  const labels = useMemo(
    () =>
      Object.fromEntries(
        table.headers.map((header) => [
          header.key,
          HEADER_LABELS[header.key] ? t(HEADER_LABELS[header.key]) : header.label,
        ]),
      ),
    [table.headers, t],
  );
  const title = t(KIND_LABELS[table.kind] ?? table.kind);
  const rows = showAll ? table.items : table.items.slice(0, PAGE_SIZE);
  const csv = useMemo(() => extractionToCsv(table, labels), [table, labels]);
  const markdown = useMemo(() => extractionToMarkdown(table, labels), [table, labels]);

  const copy = async (kind: "csv" | "markdown") => {
    try {
      await navigator.clipboard.writeText(kind === "csv" ? csv : markdown);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      // clipboard may be unavailable; downloads still work
    }
  };

  return (
    <section className="studio-extraction">
      <div className="studio-extraction-head">
        <span className="studio-extraction-title">
          <Table2 size={12} />
          <strong>{title}</strong>
          <b>{table.total}</b>
          {table.unique !== table.total ? (
            <small>{t("{count} unique", { count: table.unique })}</small>
          ) : null}
          {table.truncated ? <small className="is-warn">{t("truncated")}</small> : null}
        </span>
        <span className="studio-extraction-actions">
          <button onClick={() => void copy("csv")} title={t("Copy CSV")}>
            {copied === "csv" ? <Check size={10} /> : <Copy size={10} />}
            {t("Copy CSV")}
          </button>
          <button
            onClick={() => downloadFile(`extraction-${table.kind}.csv`, csv, "text/csv;charset=utf-8")}
            title={t("Download CSV")}
          >
            <Download size={10} />
            {t("CSV")}
          </button>
          <button
            onClick={() =>
              downloadFile(`extraction-${table.kind}.md`, markdown, "text/markdown;charset=utf-8")
            }
            title={t("Download Markdown")}
          >
            <Download size={10} />
            {t("Markdown")}
          </button>
          <button onClick={() => void copy("markdown")} title={t("Copy Markdown")}>
            {copied === "markdown" ? <Check size={10} /> : <Copy size={10} />}
            {t("Copy Markdown")}
          </button>
        </span>
      </div>
      <div className="studio-extraction-table-wrap">
        <table>
          <thead>
            <tr>
              {table.headers.map((header) => (
                <th key={header.key}>{labels[header.key]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr
                key={`${item.key}-${item.file}-${item.line}`}
                className={onOpenFile && item.file ? "is-clickable" : ""}
                onClick={() => {
                  if (item.file && onOpenFile) onOpenFile(item.file, item.line);
                }}
                title={item.file ? `${item.file}:${item.line}` : undefined}
              >
                {table.headers.map((header) => (
                  <td key={header.key}>{item.values[header.key] || "—"}</td>
                ))}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, table.headers.length)} className="is-empty">
                  {t("No items.")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {table.items.length > PAGE_SIZE ? (
        <div className="studio-extraction-foot">
          <span>
            {showAll
              ? t("Showing all {count} items", { count: table.items.length })
              : t("Showing {shown} of {count} items", {
                  shown: PAGE_SIZE,
                  count: table.items.length,
                })}
          </span>
          <button onClick={() => setShowAll((value) => !value)}>
            {showAll ? t("Show fewer") : t("Show all {count}", { count: table.items.length })}
          </button>
        </div>
      ) : null}
      {onOpenFile && table.items.some((item) => item.file) ? (
        <div className="studio-extraction-hint">
          <FileCode2 size={10} /> {t("Click a row to open its file and line.")}
        </div>
      ) : null}
    </section>
  );
}
