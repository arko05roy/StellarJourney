#!/usr/bin/env node
/**
 * Validate the Prisma schema from an isolated working directory.
 *
 * Prisma loads both `<cwd>/.env` and `<schema-dir>/.env`, then rejects
 * duplicate variable names. Paymap intentionally supports a root demo `.env`
 * alongside `prisma/.env`, so validation must not treat the root file as a
 * second Prisma environment source.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const prismaBinary = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);
const schemaPath = join(repoRoot, "prisma", "schema.prisma");
const isolatedCwd = mkdtempSync(join(tmpdir(), "paymap-prisma-validate-"));

try {
  const result = spawnSync(prismaBinary, ["validate", "--schema", schemaPath], {
    cwd: isolatedCwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(isolatedCwd, { recursive: true, force: true });
}
