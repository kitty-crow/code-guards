import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { options } from "../src/cli.ts";
import { documentation, noNestedIf, typeReuse, functionQuality, codeHealth } from "../src/guards/index.ts";
import { loadProject } from "../src/project.ts";
import { supportsReuse, type SemanticScorer } from "../src/semantic.ts";
import { guards } from "../src/model.ts";
import { writeFixture } from "./fixture.ts";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function project(files: Record<string, string>) {
  return loadProject(writeFixture({
    ...files,
    "tsconfig.json": JSON.stringify({compilerOptions: {strict: true, noEmit: true}, include: ["**/*.ts"]})
  }, temporary, "code-guards-"));
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
  const [nested = null, chained = null] = result;
  assert.ok(nested && chained);
  assert.match(nested.suggestion, /else branch remains reachable/i);
  assert.match(chained.reason, /mutually exclusive/i);
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
  assert.deepEqual(result.map(item => item.code), ["CG101"]);
});

test("CG101 treats module augmentations as a single canonical declaration", async () => {
  const sample = project({
    "tensor.ts": "export interface Tensor<R extends number = number> { rank: R; size: number }",
    "abs.ts": "import './tensor'; declare module './tensor' { interface Tensor<R extends number = number> { abs(): Tensor<R> } }",
    "neg.ts": "import './tensor'; declare module './tensor' { interface Tensor<R extends number = number> { neg(): Tensor<R> } }"
  });
  const forbidden: SemanticScorer = async () => { throw new Error("Merged declarations must not reach NLP"); };
  assert.deepEqual(await typeReuse(sample, false, forbidden), []);
});

test("CG101 does not report aliases or rank specialisations of a canonical type", async () => {
  const fields = Array.from({ length: 35 }, (_, index) => `field${index}: string;`).join(" ");
  const sample = project({
    "tensor.ts": `export enum Rank { R0, R1 } export interface Tensor<R extends Rank = Rank> { rank: R; ${fields} }`,
    "scalar.ts": "import { Tensor, Rank } from './tensor'; export type Scalar = Tensor<Rank.R0>;",
    "vector.ts": "import { Tensor, Rank } from './tensor'; export type Vector = Tensor<Rank.R1>;",
    "alias.ts": "import { Tensor as Original } from './tensor'; export type Alias = (Original);",
    "reexport.ts": "export { Tensor as PublicTensor } from './tensor';",
    "alias-chain.ts": "import { Alias } from './alias'; export type AliasChain = Alias;"
  });
  const forbidden: SemanticScorer = async () => { throw new Error("Canonical aliases must not reach NLP"); };
  assert.deepEqual(await typeReuse(sample, false, forbidden), []);
});

test("CG101 retains genuine independent duplicates after declaration merging", async () => {
  const sample = project({
    "base.ts": "export interface Contact { name: string; email: string }",
    "augment.ts": "import './base'; declare module './base' { interface Contact { phone: string } }",
    "alias.ts": "import { Contact } from './base'; export type Alias = Contact;",
    "copy.ts": "export interface ContactCopy { name: string; email: string; phone: string }"
  });
  const forbidden: SemanticScorer = async () => { throw new Error("Identical independent shapes must not reach NLP"); };
  const findings = await typeReuse(sample, false, forbidden);
  assert.deepEqual(findings.map(item => item.code), ["CG101"]);
  const finding = findings[0] ?? null;
  assert.ok(finding && "related" in finding);
  assert.equal(finding.related.file, "base.ts");
  assert.equal(findings[0]?.location.file, "copy.ts");
});

test("CG101 preserves nested generic arguments even for large phantom types", async () => {
  const fields = Array.from({ length: 35 }, (_, index) => `field${index}: string;`).join(" ");
  const sample = project({
    "base.ts": `export interface Payload<T> { ${fields} }`,
    "one.ts": "import { Payload } from './base'; export interface One { value: Payload<0>; id: string }",
    "two.ts": "import { Payload } from './base'; export interface Two { value: Payload<1>; id: string }"
  });
  assert.deepEqual(await typeReuse(sample, false, endorse), []);
});

test("CG101 distinguishes large records with incompatible literal discriminants", async () => {
  const fields = Array.from({ length: 35 }, (_, index) => `field${index}: string;`).join(" ");
  const sample = project({
    "one.ts": `export interface Event { kind: 'open'; ${fields} }`,
    "two.ts": `export interface Event { kind: 'closed'; ${fields} }`
  });
  assert.ok((await typeReuse(sample, false, endorse)).every(item => item.code !== "CG101"));
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
  const finding = result[0] ?? null;
  assert.ok(finding);
  assert.equal(finding.code, "CG103");
  assert.equal(finding.severity, "warning");
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
  const steps = Array.from(Array<number>(28).keys(), i => `if (i === ${i}) { i += 1; }`).join("\n");
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

test("documentation commands use the nearest package manifest", async () => {
  const sample = project({
    "one.ts": "export const valid = 1;",
    "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    "README.md": "# Parent\n\n```sh\nnpm run build\n```\n",
    "plugins/tool/package.json": JSON.stringify({ scripts: { bootstrap: "bun src/cli.ts" } }),
    "plugins/tool/docs/use.md": "# Tool\n\n```sh\nnpm run bootstrap\nnpm run build\nnpm run missing\n```\n"
  });
  const findings = await documentation(sample, reject);
  const commands = findings.filter(finding => finding.code === "CG406");
  assert.deepEqual(commands.map(finding => [finding.location.file, finding.subject]), [
    ["plugins/tool/docs/use.md", "npm run build"],
    ["plugins/tool/docs/use.md", "npm run missing"]
  ]);
});

test("line exceptions apply to direct guard calls without suppressing the body", () => {
  const marker = "//" + "@cg-ignore";
  const signature = "export function abi(a: number, b: number, c: number, d: number, e: number, f: number, g: number): number {";
  const sample = project({ "abi.ts": [
    marker, signature, "  if (a) {", "    if (b) return a;", "  }",
    "  return a + b + c + d + e + f + g;", "}",
    "", signature.replace("abi(", "ordinary("), "  return a + b + c + d + e + f + g;", "}"
  ].join("\r\n") });
  const contracts = codeHealth(sample, true).filter(item => item.code === "CG312");
  assert.deepEqual(contracts.map(item => item.location.line), [9]);
  assert.deepEqual(noNestedIf(sample).map(item => item.location.line), [4]);
});

test("line exceptions do not cross a blank line or match inline comments", () => {
  const marker = "//" + "@cg-ignore";
  const sample = project({ "one.ts": [
    "export function nested(a: boolean, b: boolean): number {",
    "  if (a) {", "    " + marker, "    if (b) return 1;",
    "    " + marker, "", "    if (b) return 2;",
    "    const n = 3; " + marker, "    if (b) return n;",
    "  }", "  return 0;", "}"
  ].join("\n") });
  assert.deepEqual(noNestedIf(sample).map(item => item.location.line), [7, 9]);
});
