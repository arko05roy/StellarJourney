import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".env",
  ".example",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const STELLAR_SECRET = /\bS[A-Z2-7]{55}\b/;
const PRIVATE_KEY = /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/;
const LOGGER_CALL = /\b(?:console\.(?:debug|error|info|log|warn)|log)\s*\(/;
const SECRET_IDENTIFIER = /\b(?:apiKey|authorization|privateKey|relayerSecret|secret|seed)\b/i;
const REPOSITORY_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function logsSecretIdentifier(line: string): boolean {
  if (!LOGGER_CALL.test(line)) return false;
  const withoutQuotedText = line
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, "")
    .replace(/`([^`]*)`/g, (_template, body: string) =>
      [...body.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1] ?? "").join(" "),
    );
  return SECRET_IDENTIFIER.test(withoutQuotedText);
}

function trackedTextFiles(): string[] {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: REPOSITORY_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((file) => TEXT_EXTENSIONS.has(extname(file)) || file === ".env.example");
}

function hasSecretShapedKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => /(?:secret|privateKey|seed)/i.test(key) || hasSecretShapedKey(child),
  );
}

function main(): void {
  const findings: string[] = [];
  const files = trackedTextFiles();
  for (const file of files) {
    const source = readFileSync(join(REPOSITORY_ROOT, file), "utf8");
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (STELLAR_SECRET.test(line))
        findings.push(`${file}:${String(index + 1)} hard-coded Stellar secret seed`);
      if (PRIVATE_KEY.test(line))
        findings.push(`${file}:${String(index + 1)} embedded private key`);
      if (!file.endsWith("audit-secrets.ts") && logsSecretIdentifier(line)) {
        findings.push(`${file}:${String(index + 1)} possible secret passed to a logger`);
      }
    });

    if (file.startsWith("deployments/")) {
      const parsed = JSON.parse(source) as unknown;
      if (hasSecretShapedKey(parsed))
        findings.push(`${file}: deployment registry contains a secret-shaped field`);
    }
  }

  for (const file of files.filter(
    (candidate) => /^\.env(?:\.|$)/.test(candidate) && candidate !== ".env.example",
  )) {
    findings.push(`${file}: tracked runtime environment file`);
  }

  const ignoredEnv = execFileSync("git", ["check-ignore", ".env"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  if (ignoredEnv !== ".env") findings.push(".env is not ignored");

  if (findings.length > 0) {
    throw new Error(
      `Secret audit failed:\n${findings.map((finding) => `- ${finding}`).join("\n")}`,
    );
  }
  console.log(
    `Secret audit passed (${String(files.length)} source files; no embedded keys, tracked runtime envs, secret-bearing deployments, or secret logging).`,
  );
}

main();
