/**
 * Security test for this phase's hard requirement (CLAUDE.md's lead
 * decision #1): merchant sessions and integration credentials must never
 * reach client-side JavaScript except an explicitly one-time-displayed new
 * integration key.
 *
 * Two independent proofs, not one:
 *
 * 1. **Enforced at build time** — `merchant-session.ts` and `merchant-api.ts`
 *    both start with `import "server-only"`. That package throws a real
 *    build error the instant any Client Component (`"use client"`) file
 *    imports either module, transitively or not — this isn't a lint
 *    convention, `pnpm build` (part of this phase's own gate) would fail
 *    outright if it were violated. This test doesn't re-run a full Next
 *    build (slow, redundant with the gate); it instead proves the *source
 *    files this guarantee depends on* actually still declare it, so a
 *    future edit that silently drops the `import "server-only"` line is
 *    caught here immediately rather than only at the next full build.
 *
 * 2. **Verified statically here** — every `"use client"` file under
 *    `src/components/merchant/**` and `src/app/merchant/**` is scanned for
 *    any import of the two server-only modules by name/path. A Client
 *    Component that ever imports them directly is a real leak vector
 *    (its module graph, including whatever it does with the credential, ships to
 *    the browser) independent of whether `server-only` would also catch it
 *    at build time — this test fails fast, in this package's own `pnpm
 *    test`, without needing a full `next build` to discover the mistake.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(import.meta.dirname, "..");
const SERVER_ONLY_MODULES = ["merchant-session", "merchant-api"];

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      files.push(full);
    }
  }
  return files;
}

describe("merchant-session.ts / merchant-api.ts declare `server-only`", () => {
  it.each(["merchant-session.ts", "merchant-api.ts"])(
    '%s starts with `import "server-only";`',
    (filename) => {
      const source = readFileSync(join(SRC_ROOT, "lib", filename), "utf8");
      expect(source).toMatch(/^\s*import "server-only";/m);
    },
  );
});

/**
 * A *type-only* import (`import type { X } from "./merchant-api"`) is erased
 * entirely at compile time — it adds nothing to the client bundle and is not
 * a leak (the exact `next build` behavior `tasks/lessons.md` already
 * documents for this repo's other server-only-adjacent barrels). Only a
 * *value* import (a real binding used at runtime — a function, a class, a
 * plain object) drags the module's code, and everything it touches, into
 * the bundle. This scans every `import ... from "..."` statement (including
 * ones spanning multiple lines) and flags only the non-type-only ones that
 * resolve to a server-only merchant module.
 */
function findValueImportsOfServerOnlyModules(source: string): string[] {
  const importStatementPattern = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g;
  const offenders: string[] = [];
  for (const match of source.matchAll(importStatementPattern)) {
    const [, typeOnlyKeyword, , importPath] = match;
    if (typeOnlyKeyword) continue; // `import type { ... } from "..."` — erased, not a real leak.
    if (importPath && SERVER_ONLY_MODULES.some((moduleName) => importPath.includes(moduleName))) {
      offenders.push(importPath);
    }
  }
  return offenders;
}

describe("no Client Component imports a server-only merchant module", () => {
  const roots = [join(SRC_ROOT, "components", "merchant"), join(SRC_ROOT, "app", "merchant")];
  const allFiles = roots.flatMap(walk);
  const clientFiles = allFiles.filter((path) => /^"use client";?/.test(readFileSync(path, "utf8")));

  it("found at least one client component to check (the test itself isn't vacuous)", () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it("the scanner itself correctly ignores a type-only import (control case, proves no false positives)", () => {
    const offenders = findValueImportsOfServerOnlyModules(
      'import type { MerchantProduct } from "@/lib/merchant-api";\n',
    );
    expect(offenders).toEqual([]);
  });

  it("the scanner itself correctly flags a value import (control case, proves the check has teeth)", () => {
    const offenders = findValueImportsOfServerOnlyModules(
      'import { getMerchantSessionToken } from "@/lib/merchant-session";\n',
    );
    expect(offenders).toEqual(["@/lib/merchant-session"]);
  });

  it.each(clientFiles.map((path) => [path.replace(SRC_ROOT, ""), path] as const))(
    "%s never value-imports a server-only merchant module",
    (_label, path) => {
      const source = readFileSync(path, "utf8");
      expect(findValueImportsOfServerOnlyModules(source)).toEqual([]);
    },
  );
});
