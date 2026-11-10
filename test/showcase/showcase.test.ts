import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { run } from "../../src/cli.ts";
import { noNestedIf } from "../../src/guards/no-nested-if.ts";
import { typeReuse } from "../../src/guards/type-reuse.ts";
import { functionQuality } from "../../src/guards/function-quality.ts";
import { loadProject } from "../../src/project.ts";
import type { SemanticScorer } from "../../src/semantic.ts";

const violations = path.resolve("examples/violations/tsconfig.json");
const semantic = path.resolve("examples/semantic/tsconfig.json");
const reject: SemanticScorer = async () => ({ sameConcept: 0.03, differentConcept: 0.98 });
const endorse: SemanticScorer = async () => ({ sameConcept: 0.97, differentConcept: 0.02 });

test("showcase detects nested control flow including else-if", () => {
  const findings = noNestedIf(loadProject(violations));
  assert.equal(findings.length, 2);
  assert.ok(findings.every(finding => finding.code === "CG001"));
  assert.ok(findings.some(finding => /return "pending"/.test(finding.suggestion ?? "")));
});

test("showcase detects identical types and repeated implementations without NLP", async () => {
  const project = loadProject(violations);
  const types = await typeReuse(project, false, reject);
  const functions = await functionQuality(project, false, reject);
  assert.deepEqual(types.map(finding => finding.code), ["CG101"]);
  assert.deepEqual(functions.map(finding => finding.code), ["CG205"]);
});

test("showcase warnings succeed by default and fail with --strict", async () => {
  assert.equal(await run(["--project", violations]), 0);
  assert.equal(await run(["--project", violations, "--strict"]), 1);
  assert.equal(await run(["no-nested-if", "--project", violations, "--strict", "--disable", "no-nested-if"]), 0);
});

test("semantic showcase exercises every advisory function-quality category with an injected scorer", async () => {
  const project = loadProject(semantic);
  const functions = await functionQuality(project, false, endorse);
  const codes = new Set(functions.map(finding => finding.code));
  assert.ok(codes.has("CG201"));
  assert.ok(codes.has("CG202"));
  assert.ok(codes.has("CG203"));
  assert.ok(codes.has("CG204"));
  assert.ok(functions.every(finding => finding.reason && finding.suggestion && finding.subject && finding.location.line > 0));
  assert.ok(functions.some(finding => finding.code === "CG203" && /other source modules|other source modules|other source modules|a\.ts|b\.ts/.test(finding.reason ?? "")));
  const types = await typeReuse(project, false, endorse);
  assert.ok(types.some(finding => finding.code === "CG103"));
});

test("real CLI process prints diagnostic codes and returns distinct exit codes", () => {
  const args = ["dist/src/cli.js", "--project", violations];
  const advisory = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.match(advisory.stdout, /WARNING  CG001/);
  assert.match(advisory.stdout, /WARNING  CG101/);
  assert.match(advisory.stdout, /WARNING  CG205/);
  const strict = spawnSync(process.execPath, [...args, "--strict"], { encoding: "utf8" });
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stdout, /\d+ finding\(s\): \d+ warning\(s\)/);
});

test("all demo and guard scripts rebuild the CLI before executing dist", () => {
  const packageFile = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const [name, command] of Object.entries(packageFile.scripts)) {
    if (!name.startsWith("demo") && !name.startsWith("guards")) continue;
    assert.ok(command.startsWith("tsc -p tsconfig.build.json && "), `${name} must compile the current CLI`);
    assert.match(command, /dist\/src\/cli\.js|(?:dist\/)?examples\/coverage\/(?:run|check-model)\.(?:mts|mjs)/, `${name} should invoke the compiled CLI or compiled showcase runner`);
  }
});
