import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const guard = (databaseUrl, testDatabaseUrl) => spawnSync(process.execPath, ["scripts/assert-test-database.js"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: databaseUrl, REGEAR_TEST_DATABASE_URL: testDatabaseUrl }
});

test("database guard allows separate PostgreSQL development and test databases", () => {
  const result = guard("postgresql://dev:secret@db.example:5432/regear", "postgresql://test:secret@db.example:5432/regear_test");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("database guard rejects the same database despite different credentials and query strings", () => {
  const result = guard("postgresql://dev:secret@db.example:5432/regear_test?schema=public", "postgres://test:other@db.example/regear_test?connect_timeout=3");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be isolated/);
});

test("database guard rejects a test database without the required suffix", () => {
  const result = guard("postgresql://dev:secret@db.example:5432/regear", "postgresql://test:secret@db.example:5432/regear");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ends with _test/);
});
