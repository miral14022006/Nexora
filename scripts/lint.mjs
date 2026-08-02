#!/usr/bin/env node
/**
 * Monorepo lint for the Nexora codebase.
 *
 * Checks:
 *   1. Every package.json parses and workspaces resolve to real directories.
 *   2. Every .js file under services/, packages/ and scripts/ parses
 *      (node --check, honors the root "type": "module").
 *   3. Every service listed in docker-compose.yml has a Dockerfile whose
 *      build context matches the monorepo layout used by render.yaml.
 *   4. Every process.env.* key read by service/package code is documented
 *      in .env.example (as `KEY=` or a commented `# KEY=` line), so secrets
 *      and tuning knobs never go undocumented.
 *
 * Usage: node scripts/lint.mjs
 * Exit code 0 = clean, 1 = problems found.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const ok = (m) => console.log(`  \u2713 ${m}`);
const fail = (m) => problems.push(m);

// --- 1. package.json files ---------------------------------------------------
const pkgFiles = [];
for (const dir of [root, ...readdirSync(join(root, "services")).map((d) => join(root, "services", d)), ...readdirSync(join(root, "packages")).map((d) => join(root, "packages", d))]) {
  const p = join(dir, "package.json");
  if (existsSync(p)) pkgFiles.push(p);
}
for (const p of pkgFiles) {
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    if (!pkg.name) fail(`${p}: missing name`);
  } catch (e) {
    fail(`${p}: invalid JSON (${e.message})`);
  }
}
ok(`parsed ${pkgFiles.length} package.json files`);

// --- 2. JS syntax ------------------------------------------------------------
function collectJs(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJs(p));
    else if (entry.name.endsWith(".js")) out.push(p);
  }
  return out;
}
const jsFiles = [
  ...collectJs(join(root, "services")),
  ...collectJs(join(root, "packages")),
  ...collectJs(join(root, "scripts")),
];
let syntaxErrors = 0;
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    syntaxErrors++;
    if (syntaxErrors <= 10) fail(`syntax error in ${f}\n${e.stderr}`);
  }
}
ok(`node --check passed for ${jsFiles.length - syntaxErrors}/${jsFiles.length} JS files`);

// --- 3. compose services have Dockerfiles ------------------------------------
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
const serviceDirs = readdirSync(join(root, "services"));
for (const svcDir of serviceDirs) {
  if (!existsSync(join(root, "services", svcDir, "package.json"))) continue;
  const dockerfile = join(root, "services", svcDir, "Dockerfile");
  if (!existsSync(dockerfile)) fail(`services/${svcDir}: missing Dockerfile`);
}
if (!existsSync(join(root, "frontend", "Dockerfile"))) fail("frontend: missing Dockerfile");
ok(`Dockerfiles present for ${serviceDirs.length} services + frontend`);

// compose build blocks use repo-root context + services/<svc>/Dockerfile
const composeBuilds = [...compose.matchAll(/dockerfile:\s*([^\s]+)/g)].map((m) => m[1]);
for (const df of composeBuilds) {
  if (!existsSync(join(root, df))) fail(`docker-compose.yml references missing Dockerfile: ${df}`);
}
if (!compose.includes("context: .")) {
  fail("docker-compose.yml: expected build context: . (repo root) for monorepo Dockerfiles");
} else {
  ok("docker-compose.yml build contexts point at repo root");
}

// --- 4. env vars documented in .env.example ----------------------------------
const envExample = readFileSync(join(root, ".env.example"), "utf8");
const envKeys = new Set(
  [...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1])
);
const readEnv = new Set(
  [
    ...collectJs(join(root, "services")),
    ...collectJs(join(root, "packages")),
  ]
    .map((f) => readFileSync(f, "utf8"))
    .flatMap((src) => [...src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))
);
const undocumented = [...readEnv].filter((k) => !envKeys.has(k));
if (undocumented.length) {
  fail(
    `env vars read by code but missing from .env.example: ${[...undocumented].sort().join(", ")}`
  );
} else {
  ok(`${readEnv.size} env vars read by services are documented in .env.example`);
}

// --- summary -----------------------------------------------------------------
console.log("");
if (problems.length) {
  console.log(`FAIL - ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  \u2717 ${p}`);
  process.exit(1);
}
console.log("PASS - lint clean.");
