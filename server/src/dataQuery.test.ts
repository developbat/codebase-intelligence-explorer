import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { queryCsvFile, querySqliteFile, validateSqliteQuery } from "./dataQuery";

const hasSqlite = spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).status === 0;

test("csv_query parses quoted fields, columns, filters and counts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-csv-"));
  try {
    await fs.mkdir(path.join(root, "data"), { recursive: true });
    await fs.writeFile(
      path.join(root, "data", "users.csv"),
      'name,note,active\nAlice,"hello, world",true\nBob,"say ""hi""",false\nCara,plain,true\n',
    );

    const limited = JSON.parse(
      await queryCsvFile(root, "data/users.csv", { columns: ["name", "note"], limit: 2 }),
    );
    assert.equal(limited.totalRows, 3);
    assert.equal(limited.returnedRows, 2);
    assert.deepEqual(limited.columns, ["name", "note"]);
    assert.equal(limited.rows[0].note, "hello, world");
    assert.equal(limited.rows[1].note, 'say "hi"');

    const count = JSON.parse(await queryCsvFile(root, "data/users.csv", { count: true }));
    assert.equal(count.totalRows, 3);
    assert.equal(count.matchedRows, 3);

    const active = JSON.parse(
      await queryCsvFile(root, "data/users.csv", {
        where: { column: "active", equals: "true" },
        columns: ["name"],
      }),
    );
    assert.deepEqual(active.rows, [{ name: "Alice" }, { name: "Cara" }]);

    const contains = JSON.parse(
      await queryCsvFile(root, "data/users.csv", {
        where: { column: "note", contains: "hi" },
        columns: ["name"],
      }),
    );
    assert.deepEqual(contains.rows, [{ name: "Bob" }]);

    const columnsOnly = JSON.parse(
      await queryCsvFile(root, "data/users.csv", { columnsOnly: true }),
    );
    assert.deepEqual(columnsOnly.columns, ["name", "note", "active"]);

    await assert.rejects(() =>
      queryCsvFile(root, "data/users.csv", { columns: ["missing"] }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "sqlite_query runs read-only queries and rejects writes, multiple statements and file access",
  { skip: !hasSqlite },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-sqlite-"));
    try {
      const dbPath = path.join(root, "app.db");
      execFileSync("sqlite3", [
        dbPath,
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT); INSERT INTO users (name,email) VALUES ('Alice','a@example.com'),('Bob','b@example.com');",
      ]);

      const output = await querySqliteFile(
        root,
        "app.db",
        "SELECT name, email FROM users ORDER BY id",
      );
      const json = JSON.parse(output.slice(output.indexOf("\n") + 1));
      assert.deepEqual(json, [
        { name: "Alice", email: "a@example.com" },
        { name: "Bob", email: "b@example.com" },
      ]);

      assert.equal(validateSqliteQuery("  SELECT 1;  "), "SELECT 1");
      assert.equal(validateSqliteQuery("-- comment\nWITH x AS (SELECT 1) SELECT * FROM x").startsWith("-- comment"), true);
      await assert.rejects(() => querySqliteFile(root, "app.db", "DELETE FROM users"));
      await assert.rejects(() => querySqliteFile(root, "app.db", "SELECT 1; DELETE FROM users"));
      await assert.rejects(() => querySqliteFile(root, "app.db", "SELECT readfile('/etc/passwd')"));
      await assert.rejects(() => querySqliteFile(root, "app.db", "PRAGMA table_info(users)"));
      await assert.rejects(() => querySqliteFile(root, "../outside.db", "SELECT 1"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
