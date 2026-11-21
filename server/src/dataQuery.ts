import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isSecretProjectPath } from "./editor";
import { isWithin } from "./scanner";

const execFileAsync = promisify(execFile);
const MAX_CSV_BYTES = 8_000_000;
const MAX_SQLITE_QUERY_CHARS = 4_000;
const MAX_SQLITE_OUTPUT_CHARS = 200_000;
const MAX_CSV_ROWS = 200;
const CSQL_EXTENSIONS = new Set([".csv", ".tsv", ".tab", ".txt"]);

async function resolveDataFile(
  rootPath: string,
  filePath: string,
): Promise<{ relative: string; absolute: string }> {
  const relative = filePath.replace(/^\/+/, "");
  if (!relative) throw new Error("A file path is required.");
  if (isSecretProjectPath(relative)) {
    throw new Error("Environment, key and Git internals files cannot be queried.");
  }
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("That path is outside the project root.");
  const realRoot = await fs.realpath(rootPath);
  const realFile = await fs.realpath(absolute);
  if (!isWithin(realRoot, realFile)) throw new Error("That path is outside the project root.");
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error("The path is not a file.");
  return {
    relative: path.relative(realRoot, realFile).split(path.sep).join("/"),
    absolute: realFile,
  };
}

function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (inQuotes) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim().length > 0));
}

function columnList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return undefined;
}

export interface CsvQueryInput {
  columns?: unknown;
  where?: unknown;
  limit?: unknown;
  count?: unknown;
  columnsOnly?: unknown;
}

export async function queryCsvFile(
  rootPath: string,
  filePath: string,
  input: CsvQueryInput = {},
): Promise<string> {
  const file = await resolveDataFile(rootPath, filePath);
  const extension = path.extname(file.relative).toLowerCase();
  if (!CSQL_EXTENSIONS.has(extension)) {
    throw new Error("csv_query supports .csv, .tsv, .tab and .txt files.");
  }
  const stat = await fs.stat(file.absolute);
  if (stat.size > MAX_CSV_BYTES) throw new Error("The CSV file is too large (maximum 8 MB).");
  const content = await fs.readFile(file.absolute, "utf8");
  if (content.includes("\0")) throw new Error("The file does not look like a text CSV.");
  const delimiter = extension === ".tsv" || extension === ".tab" ? "\t" : ",";
  const rows = parseDelimited(content.replace(/^\uFEFF/, ""), delimiter);
  if (rows.length === 0) throw new Error("The CSV file is empty.");
  const headers = rows[0].map((header) => header.trim());
  const dataRows = rows.slice(1);

  if (input.columnsOnly === true) {
    return JSON.stringify({ file: file.relative, columns: headers });
  }

  const selectedColumns = columnList(input.columns);
  const projection = selectedColumns ?? headers;
  for (const column of projection) {
    if (!headers.includes(column)) {
      throw new Error(`Unknown column "${column}". Available: ${headers.join(", ")}`);
    }
  }

  const where =
    input.where && typeof input.where === "object" && !Array.isArray(input.where)
      ? (input.where as Record<string, unknown>)
      : undefined;
  const whereColumn = where ? String(where.column ?? "").trim() : "";
  const equals = where && "equals" in where ? String(where.equals) : undefined;
  const contains = where && "contains" in where ? String(where.contains).toLowerCase() : undefined;
  if (whereColumn && !headers.includes(whereColumn)) {
    throw new Error(`Unknown where column "${whereColumn}". Available: ${headers.join(", ")}`);
  }

  let filtered = dataRows;
  if (whereColumn && (equals !== undefined || contains !== undefined)) {
    const index = headers.indexOf(whereColumn);
    filtered = dataRows.filter((row) => {
      const value = row[index] ?? "";
      return equals !== undefined ? value === equals : value.toLowerCase().includes(contains ?? "");
    });
  }

  const limit = Math.max(1, Math.min(MAX_CSV_ROWS, Number(input.limit ?? 20) || 20));
  const selectedRows = filtered.slice(0, limit).map((row) =>
    Object.fromEntries(projection.map((column) => [column, row[headers.indexOf(column)] ?? ""])),
  );

  if (input.count === true) {
    return JSON.stringify({
      file: file.relative,
      totalRows: dataRows.length,
      matchedRows: filtered.length,
      columns: headers,
    });
  }

  return JSON.stringify({
    file: file.relative,
    totalRows: dataRows.length,
    matchedRows: filtered.length,
    returnedRows: selectedRows.length,
    columns: projection,
    rows: selectedRows,
  });
}

export function validateSqliteQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("A SQL query is required.");
  if (trimmed.length > MAX_SQLITE_QUERY_CHARS) {
    throw new Error(`The SQL query is too long (maximum ${MAX_SQLITE_QUERY_CHARS} characters).`);
  }
  const withoutTrailing = trimmed.replace(/;+\s*$/, "");
  if (withoutTrailing.includes(";")) {
    throw new Error("Only one SQL statement is allowed.");
  }
  const normalized = withoutTrailing
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .toLowerCase();
  if (!/^(select|with|explain)\b/.test(normalized)) {
    throw new Error("Only read-only SELECT, WITH or EXPLAIN queries are allowed.");
  }
  if (
    /\b(insert|update|delete|replace|create|drop|alter|vacuum|attach|detach|pragma|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension|readfile|writefile|edit)\b/i.test(
      normalized,
    )
  ) {
    throw new Error("That SQL statement can write or access files and is not allowed.");
  }
  return withoutTrailing;
}

export async function querySqliteFile(
  rootPath: string,
  filePath: string,
  query: string,
): Promise<string> {
  const file = await resolveDataFile(rootPath, filePath);
  const sql = validateSqliteQuery(query);
  try {
    const result = await execFileAsync(
      "sqlite3",
      ["-readonly", "-cmd", ".mode json", file.absolute, sql],
      { timeout: 15_000, maxBuffer: 2_000_000 },
    );
    const output = `${result.stdout}${result.stderr ?? ""}`.trim();
    if (!output) return `SQLite: ${file.relative}\nNo rows returned.`;
    return `SQLite: ${file.relative}\n${output.slice(0, MAX_SQLITE_OUTPUT_CHARS)}`;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (failure.code === "ENOENT") {
      throw new Error("The sqlite3 command line tool is not installed.");
    }
    const detail = `${failure.stderr ?? ""}${failure.stdout ?? ""}`.toString().trim();
    throw new Error(detail || failure.message || "SQLite query failed.");
  }
}
