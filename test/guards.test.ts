import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { noNestedIf } from "../src/guards/no-nested-if.ts";
import { typeReuse } from "../src/guards/type-reuse.ts";
import { functionQuality } from "../src/guards/function-quality.ts";
import { options } from "../src/cli.ts";
import { loadProject } from "../src/project.ts";
import { supportsReuse, type SemanticScorer } from "../src/semantic.ts";
import { guards } from "../src/model.ts";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function project(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "code-guards-"));
  temporary.push(dir);
  for (const [filename, content] of Object.entries(files)) {
    const destination = path.join(dir, filename);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["**/*.ts"] }));
  return loadProject(path.join(dir, "tsconfig.json"));
}

const endorse: SemanticScorer = async () => ({ sameConcept: 0.96, differentConcept: 0.05 });
const reject: SemanticScorer = async () => ({ sameConcept: 0.08, differentConcept: 0.98 });

test("nested if and else-if produce advisory warnings with actionable guidance", () => {
  const sample = project({ "one.ts": `
    function nested(a: boolean, b: boolean) {
      if (a) { if (b) return; } else if (b) return;
      if (!a) return;
      if (!b) return;
    }
  ` });
  const result = noNestedIf(sample);
  assert.equal(result.length, 2);
  assert.ok(result.every(finding => finding.code === "CG001" && finding.severity === "warning"));
  assert.match(result[0]?.suggestion ?? "", /else branch remains reachable/i);
  assert.match(result[1]?.reason ?? "", /mutually exclusive/i);
});

test("a nested function resets control-flow nesting", () => {
  const sample = project({ "one.ts": `function outer(a: boolean) {
    if (a) { const inner = () => { if (a) return; }; inner(); }
  }` });
  assert.equal(noNestedIf(sample).length, 0);
});

test("matching types across files are reported without running NLP", async () => {
  const sample = project({
    "one.ts": "export interface EnquiryContact { name: string; email: string | null; company?: string }",
    "two.ts": "export type ProjectContact = { company?: string; email: string | null; name: string };"
  });
  const forbidden: SemanticScorer = async () => { throw new Error("NLP should not run for identical shapes"); };
  const result = await typeReuse(sample, false, forbidden);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.code, "CG101");
});

test("conceptual type reuse invokes zero-shot scorer", async () => {
  const sample = project({
    "one.ts": "export interface Customer { name: string; email: string }",
    "two.ts": "export interface Client { fullName: string; emailAddress: string }"
  });
  let called = false;
  const scorer: SemanticScorer = async question => {
    called = true;
    assert.match(question.premise, /Customer/);
    assert.match(question.premise, /Client/);
    return { sameConcept: 0.94, differentConcept: 0.03 };
  };
  const result = await typeReuse(sample, false, scorer);
  assert.equal(called, true);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.code, "CG103");
  assert.equal(result[0]?.severity, "warning");
  assert.deepEqual(await typeReuse(sample, false, reject), []);
});

test("primitive and collection aliases do not get reported as duplicates", async () => {
  const sample = project({
    "one.ts": "export type Person = string | null;",
    "two.ts": "export type People = (string | null)[];"
  });
  assert.deepEqual(await typeReuse(sample, false, endorse), []);
});

test("unrelated classes with similar shapes are never marked exact duplicates", async () => {
  const sample = project({
    "one.ts": "export class BillingAddress { street = ''; city = ''; }",
    "two.ts": "export class ShippingAddress { street = ''; city = ''; }"
  });
  assert.ok((await typeReuse(sample, false, endorse)).every(item => item.code !== "CG101"));
});

test("test files are excluded from type reuse by default", async () => {
  const sample = project({
    "src/a.ts": "export type A = { id: number; name: string }",
    "test/b.test.ts": "export type B = { id: number; name: string }"
  });
  assert.equal((await typeReuse(sample, false, endorse)).length, 0);
  assert.equal((await typeReuse(sample, true, endorse)).length, 1);
});

test("string literal unions must not be compared as record declarations", async () => {
  const sample = project({
    "one.ts": "export type Severity = 'error' | 'warning' | 'info';",
    "two.ts": "export type Mode = 'open' | 'closed' | 'pending';"
  });
  assert.equal((await typeReuse(sample, false, endorse)).length, 0);
});

test("different discriminant literal values are not structurally identical", async () => {
  const sample = project({
    "one.ts": "export type Open = { kind: 'open'; value: string }",
    "two.ts": "export type Closed = { kind: 'closed'; value: string }"
  });
  assert.ok((await typeReuse(sample, false, reject)).every(item => item.code !== "CG101"));
});

test("function quality flags a complex uncommented function when MNLI agrees", async () => {
  const steps = Array.from({ length: 28 }, (_, i) => `if (i === ${i}) { i += 1; }`).join("\n");
  const sample = project({ "functions.ts": `export function confusing(i: number) {\n${steps}\nreturn i;\n}` });
  const result = await functionQuality(sample, false, endorse);
  assert.ok(result.some(f => f.code === "CG202"));
  assert.deepEqual(await functionQuality(sample, false, reject), []);
});

test("exact duplicate implementations are reported without model inference", async () => {
  const sample = project({
    "one.ts": "export function alpha(x: number) { const y = x + 1; const z = y + 2; return z; }",
    "two.ts": "export function beta(x: number) { const y = x + 1; const z = y + 2; return z; }"
  });
  const result = await functionQuality(sample, false, reject);
  assert.ok(result.some(f => f.code === "CG205"));
});

test("all guards default on, can disable any, and strict is explicit", () => {
  const defaults = options([]);
  assert.equal(defaults.enabled.size, guards.length);
  assert.equal(defaults.strict, false);
  const configured = options(["--disable", "type-reuse", "--strict"]);
  assert.equal(configured.enabled.size, guards.length - 1);
  assert.equal(configured.enabled.has("type-reuse"), false);
  assert.equal(configured.strict, true);
  assert.equal(options(["no-nested-if"]).enabled.size, 1);
});

test("NLP verdict must exceed confidence and contradictory score", () => {
  assert.equal(supportsReuse({ sameConcept: 0.89, differentConcept: 0.1 }), true);
  assert.equal(supportsReuse({ sameConcept: 0.91, differentConcept: 0.9 }), false);
  assert.equal(supportsReuse({ sameConcept: 0.4, differentConcept: 0.05 }), false);
});


test("similar option names do not imply reusable types without field-level evidence", async () => {
  const sample = project({
    "cli.ts": "export type Options = { enabled: Set<string>; project: string; includeTests: boolean; format: string; colour: string; strict: boolean; offline: boolean };",
    "engine.ts": "export type AnalysisOptions = { enabled: Set<string>; project: string; includeTests: boolean };",
    "report.ts": "export type ReportOptions = { root: string; format: string; colour: string; isTTY?: boolean };",
    "model.ts": "export type ClassifierOptions = { multi_label: boolean; hypothesis_template: string };"
  });
  const findings = await typeReuse(sample, false, endorse);
  assert.deepEqual(findings, [], "even a high NLI score cannot substitute for meaningful structural overlap");
});

test("complex functions with documented invariants are not reported as unexplained", async () => {
  const sample = loadProject(path.resolve("tsconfig.json"));
  const findings = await functionQuality(sample, false, endorse);
  const documented = new Set(["suggestion", "explain", "inspectFunction", "checkNarrative", "documentation"]);
  assert.deepEqual(findings.filter(item => item.code === "CG202" && documented.has(item.subject ?? "")), []);
});
