import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { readFile } from "node:fs/promises";

process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
const { default: app } = await import("../../dist/app.js");

test("health endpoint responds with service status", async () => {
  const response = await request(app).get("/health/");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("OpenAPI endpoint is served from the running Express application", async () => {
  const response = await request(app).get("/api/v1/openapi.json");
  assert.equal(response.status, 200);
  assert.equal(response.body.info.title, "ReGear API");
  assert.ok(response.body.paths["/checkout"]);
});

test("OpenAPI contains every registered marketplace and versioned auth operation", async () => {
  const response = await request(app).get("/api/v1/openapi.json");
  const [marketplaceRoutes, authRoutes, healthRoutes] = await Promise.all([
    readFile("src/routes/marketplace.routes.ts", "utf8"),
    readFile("src/routes/auth.routes.ts", "utf8"),
    readFile("src/routes/health.routes.ts", "utf8")
  ]);
  const registered = [
    ...[...marketplaceRoutes.matchAll(/router\.(get|post|patch|put|delete)\("([^"]+)"/g)].map(([, method, path]) => [method, path]),
    ...[...authRoutes.matchAll(/authRouter\.(get|post|patch|put|delete)\([\s\S]*?"(\/[^"]+)"/g)].map(([, method, path]) => [method, `/auth${path}`]),
    ...[...healthRoutes.matchAll(/healthRouter\.(get|post|patch|put|delete)\("([^"]+)"/g)].map(([, method, path]) => [method, `/health${path}`])
  ];
  for (const [method, sourcePath] of registered) {
    const path = sourcePath.replace(/:([^/]+)/g, "{$1}");
    assert.ok(response.body.paths[path]?.[method], `OpenAPI is missing ${method.toUpperCase()} ${path}`);
  }
});
