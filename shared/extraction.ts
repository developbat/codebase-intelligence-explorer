export interface ExtractionHeader {
  key: string;
  label: string;
}

export interface ExtractionItem {
  key: string;
  file: string;
  line: number;
  values: Record<string, string>;
}

export interface ExtractionTable {
  kind: string;
  headers: ExtractionHeader[];
  items: ExtractionItem[];
  total: number;
  unique: number;
  truncated: boolean;
}

function headerLabel(
  header: ExtractionHeader,
  labels?: Readonly<Record<string, string>>,
): string {
  return labels?.[header.key] ?? header.label;
}

function csvCell(value: string | undefined): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function extractionToCsv(
  table: ExtractionTable,
  labels?: Readonly<Record<string, string>>,
): string {
  const lines = [
    table.headers.map((header) => csvCell(headerLabel(header, labels))).join(","),
    ...table.items.map((item) =>
      table.headers.map((header) => csvCell(item.values[header.key])).join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function markdownCell(value: string | undefined): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function extractionToMarkdown(
  table: ExtractionTable,
  labels?: Readonly<Record<string, string>>,
): string {
  const headers = table.headers.map((header) => markdownCell(headerLabel(header, labels)));
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...table.items.map(
      (item) =>
        `| ${table.headers
          .map((header) => markdownCell(item.values[header.key]))
          .join(" | ")} |`,
    ),
  ].join("\n");
}
