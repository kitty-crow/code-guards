import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { loadProject } from "../src/project.ts";
import { options } from "../src/cli.ts";
import { noNestedIf } from "../src/guards/no-nested-if.ts";
import { documentation } from "../src/guards/documentation.ts";
import { analyse } from "../src/engine.ts";
import type { GuardName } from "../src/model.ts";
import { writeFixture } from "./fixture.ts";

const temporary: string[] = [];
afterEach(() => { for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function external(files: Record<string, string>): string {
  return writeFixture(files, temporary, "code-guards external path ");
}

function execute(target: string, args: string[] = [], cwd = process.cwd()) {
  return spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "no-nested-if", "--path", target, ...args], {
    encoding: "utf8", cwd
  });
}

const nested = `export function access(a: boolean, b: boolean): boolean {
  if (a) {
    if (b) return true;
  }
  return false;
}`;

test("external directory respects its tsconfig and never scans this library instead", () => {
  const root = external({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*.ts"] }),
    "src/validate.ts": nested,
    "ignored/ignored.ts": nested
  });
  const project = loadProject(root);
  assert.equal(project.root, root);
  assert.deepEqual(project.files.map(file => path.relative(root, file.fileName)), ["src/validate.ts"]);
  const result = execute(root, ["--format", "json"]);
  assert.equal(result.status, 0, result.stderr);
  const findings = noNestedIf(project);
  assert.deepEqual(findings.map(finding => [finding.code, finding.location.file]), [["CG001", "src/validate.ts"]]);
  assert.equal(result.stdout.trim(), JSON.stringify(findings, null, 2));
});

test("external directories without tsconfig exclude build outputs and dependency directories", () => {
  const root = external({
    "src/validate.ts": nested,
    "dist/generated.ts": nested,
    "node_modules/vendor/index.ts": nested,
    "vendor/dependency/source.ts": nested,
    "third_party/library/source.ts": nested,
    "build/copied.ts": nested
  });
  const project = loadProject(root);
  assert.deepEqual(project.files.map(file => path.relative(root, file.fileName)), ["src/validate.ts"]);
  assert.equal(noNestedIf(project).length, 1);
});

test("direct .ts path and explicit configuration both select the external project", () => {
  const root = external({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
    "src/nested.ts": nested,
    "src/clean.ts": "export const value = true;"
  });
  const file = loadProject(path.join(root, "src/nested.ts"));
  assert.equal(file.files.length, 1);
  assert.equal(noNestedIf(file).length, 1);
  assert.equal(loadProject(path.join(root, "tsconfig.json")).files.length, 2);
  assert.equal(options(["--path", root]).project, root);
  assert.equal(options(["--project", path.join(root, "tsconfig.json")]).project, path.join(root, "tsconfig.json"));
});

test("external CLI gives actionable warnings and nonzero strict exit without editing target files", () => {
  const root = external({ "src/nested.ts": nested });
  const before = readFileSync(path.join(root, "src/nested.ts"), "utf8");
  const advisory = execute(root, ["--colour", "never"]);
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.match(advisory.stdout, /CG001/);
  assert.match(advisory.stdout, /src\/nested\.ts:3:/);
  assert.match(advisory.stdout, /Clause/);
  const strict = execute(root, ["--strict", "--colour", "never"]);
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stdout, /CG001/);
  assert.equal(readFileSync(path.join(root, "src/nested.ts"), "utf8"), before);
});

test("external scan works from an unrelated working directory", () => {
  const root = external({ "src/nested.ts": nested });
  const elsewhere = external({});
  const report = execute(root, ["--format", "json"], elsewhere);
  assert.equal(report.status, 0, report.stderr);
  const findings = noNestedIf(loadProject(root));
  assert.deepEqual(findings.map(finding => finding.location.file), ["src/nested.ts"]);
  assert.equal(report.stdout.trim(), JSON.stringify(findings, null, 2));
});

test("invalid or empty external targets fail clearly instead of scanning the current repository", () => {
  const root = external({});
  const empty = execute(root);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /No TypeScript source files/);
  const missing = execute(path.join(root, "missing"));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Target does not exist/);
});

test("README includes all emitted warning codes with descriptions", () => {
  const readme = readFileSync(path.resolve("README.md"), "utf8");
  const sourceFiles = [
    "src/guards/no-nested-if.ts", "src/guards/type-reuse.ts",
    "src/guards/function-quality.ts", "src/guards/module-cohesion.ts", "src/guards/code-health.ts",
    "src/guards/cross-module.ts", "src/guards/documentation.ts",
    "src/guards/repo-hygiene.ts"
  ];
  const emitted = new Set(sourceFiles.flatMap(file => [...readFileSync(path.resolve(file), "utf8").matchAll(/CG\d{3}/g)].map(match => match[0])));
  for (const code of emitted) assert.match(readme, new RegExp("\\| `" + code + "` \\|\\s+\\S"), `README missing description for ${code}`);
});

test("explicit tsconfig and pinned submodule paths cannot cause vendored source scans", async () => {
  const root = external({
    ".gitmodules": '[submodule "external/foreign"]\n\tpath = external/foreign\n\turl = https://github.com/example/foreign.git\n',
    "tsconfig.json": JSON.stringify({compilerOptions: {strict: true, noEmit: true}, include: ["**/*.ts"]}),
    "src/clean.ts": "export const ready: boolean = true;",
    "vendor/library/bad.ts": nested,
    "third_party/library/bad.ts": nested,
    "external/foreign/bad.ts": nested,
    "vendor/library/README.md": "The most powerful solution.",
    "external/foreign/README.md": "The most powerful solution.",
    "README.md": "# Scan\n\nRun `bun run test` to execute tests."
  });
  const project = loadProject(root);
  assert.deepEqual(project.files.map(file => path.relative(root, file.fileName)), ["src/clean.ts"]);
  const docs = await documentation(project, async () => ({sameConcept: 0, differentConcept: 1}));
  assert.equal(docs.some(item => item.location.file.startsWith("vendor/") ||
    item.location.file.startsWith("third_party/") ||
    item.location.file.startsWith("external/foreign/")), false);
});

test("progress provides stage timing while keeping findings unchanged", async () => {
  const root = external({ "src/validate.ts": nested });
  const enabled = new Set<GuardName>(["no-nested-if"]);
  const messages: string[] = [];
  const analysis = await analyse({
    project: root, enabled: new Set(enabled), includeTests: false
  }, message => { messages.push(message); });
  assert.equal(analysis.findings.length, 1);
  assert.ok(messages.some(message => message.includes("Loaded 1 source files")));
  assert.ok(messages.some(message => message.includes("[1/1] no-nested-if: started")));
  assert.ok(messages.some(message => message.includes("1 findings, 0 inference windows")));
  assert.ok(messages.some(message => message.includes("Completed: 1 findings")));
});
