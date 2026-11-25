import { CodeExpert } from "../src/experts.ts";
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
  const fields = Array.from(Array<number>(35).keys(), index => `field${index}: string;`).join(" ");
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
  assert.equal(finding.location.file, "copy.ts");
});

test("CG101 recognises independent generic contracts with renamed formal parameters", async () => {
  const sample = project({
    "one.ts": "export interface One<T extends string> { value: T; id: number }",
    "two.ts": "export interface Two<U extends string> { value: U; id: number }"
  });
  const forbidden: SemanticScorer = async () => { throw new Error("Equivalent generic shapes must not reach NLP"); };
  assert.deepEqual((await typeReuse(sample, false, forbidden)).map(item => item.code), ["CG101"]);
});

test("CG101 preserves constraints and defaults of otherwise identical generic contracts", async () => {
  const sample = project({
    "one.ts": "export interface One<T extends string = 'a'> { value: T; id: number }",
    "two.ts": "export interface Two<T extends string = 'b'> { value: T; id: number }",
    "three.ts": "export interface Three<T extends number = 1> { value: T; id: number }"
  });
  assert.ok((await typeReuse(sample, false, endorse)).every(item => item.code !== "CG101"));
});

test("CG101 preserves nested generic arguments even for large phantom types", async () => {
  const fields = Array.from(Array<number>(35).keys(), index => `field${index}: string;`).join(" ");
  const sample = project({
    "base.ts": `export interface Payload<T> { ${fields} }`,
    "one.ts": "import { Payload } from './base'; export interface One { value: Payload<0>; id: string }",
    "two.ts": "import { Payload } from './base'; export interface Two { value: Payload<1>; id: string }"
  });
  assert.deepEqual(await typeReuse(sample, false, endorse), []);
});

test("CG101 distinguishes large records with incompatible literal discriminants", async () => {
  const fields = Array.from(Array<number>(35).keys(), index => `field${index}: string;`).join(" ");
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

test("type reuse semantic questions survive relocation of a checkout", async () => {
  const files = {
    "status.ts": "export enum State { Open, Closed }",
    "customer.ts": "import { State } from './status'; export interface Customer { status: State.Open; name: string; id: number }",
    "client.ts": "import { State } from './status'; export interface Client { status: State.Open; fullName: string; id: number }"
  };
  const collect = async (sample: ReturnType<typeof project>) => {
    const premises: string[] = [];
    const findings = await typeReuse(sample, false, async question => {
      premises.push(question.premise);
      return endorse(question);
    });
    assert.equal(findings.length, 1);
    assert.equal(premises.length, 1);
    return premises;
  };
  const first = project(files);
  const second = project(files);
  assert.notEqual(first.root, second.root);
  const questions = await collect(first);
  assert.deepEqual(await collect(second), questions);
  assert.ok(questions.every(question => !question.includes(first.root.replace(/\\/g, "/"))));
  assert.ok(questions.some(question => question.includes("./status")));
});

test("type reuse preserves identities of identically named enums in different modules", async () => {
  const sample = project({
    "first/status.ts": "export enum State { Open, Closed }",
    "second/status.ts": "export enum State { Open, Closed }",
    "customer.ts": "import { State } from './first/status'; export interface Customer { status: State.Open; name: string }",
    "client.ts": "import { State } from './second/status'; export interface Client { status: State.Open; fullName: string }"
  });
  const forbidden: SemanticScorer = async () => { throw new Error("Distinct enum identities must not reach NLP"); };
  assert.deepEqual(await typeReuse(sample, false, forbidden), []);
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

test("underscore and hyphen test filenames follow the include-tests option", async () => {
  const sample = project({
    "main.ts": "export interface Original { name: string; id: number }",
    "tensor_test.ts": "export interface Copy { name: string; id: number }",
    "tensor-spec.ts": "export const value: any = 1;"
  });
  assert.deepEqual(await typeReuse(sample, false, endorse), []);
  assert.equal((await typeReuse(sample, true, endorse)).length, 1);
  assert.equal(codeHealth(sample, false).filter(item => item.code === "CG305").length, 0);
  assert.ok(codeHealth(sample, true).some(item => item.code === "CG305"));
});


test("type reuse does not report inherited members as independently duplicated", async () => {
  const sample = project({
    "base.ts": "export class Base { name = ''; id = 0; active = true; reset() { this.id = 0; } }",
    "one.ts": "import { Base } from './base'; export class One extends Base { colour = ''; }",
    "two.ts": "import { Base } from './base'; export class Two extends Base { count = 0; }",
    "three.ts": "import { One } from './one'; export class Three extends One {}"
  });
  const forbidden: SemanticScorer = async () => { throw new Error("Inherited declarations are already reused"); };
  assert.deepEqual(await typeReuse(sample, false, forbidden), []);
});

test("type reuse still compares independently declared members on subclasses", async () => {
  const sample = project({
    "base.ts": "export class Base { name = ''; id = 0; active = true; }",
    "one.ts": "import { Base } from './base'; export class One extends Base { email = ''; phone = ''; }",
    "two.ts": "import { Base } from './base'; export class Two extends Base { email = ''; phone = ''; }"
  });
  const findings = await typeReuse(sample, false, endorse);
  assert.equal(findings.length, 1);
  const finding = findings[0] ?? null;
  assert.ok(finding);
  assert.equal(finding.code, "CG103");
  assert.match(finding.reason, /2 independently declared matching field/);
});

test("type reuse retains independent extensions of the same interface", async () => {
  const sample = project({
    "base.ts": "export interface Base { id: number; name: string; active: boolean }",
    "one.ts": "import { Base } from './base'; export interface One extends Base { email: string; phone: string }",
    "two.ts": "import { Base } from './base'; export interface Two extends Base { email: string; phone: string }"
  });
  const findings = await typeReuse(sample, false, endorse);
  assert.deepEqual(findings.map(finding => finding.code), ["CG101"]);
});


test("CG314 follows actual assertion helpers across imports and aliases", () => {
  const sample = project({
    "assertions.ts": "export function expectEqual(actual: number, expected: number) { if (actual !== expected) throw new Error('different'); } export function expectResult(actual: number) { expectEqual(actual, 42); }",
    "sample_test.ts": "import { expectResult as check } from './assertions'; declare function it(name: string, fn: () => void): void; it('checks result', () => { check(42); });"
  });
  assert.deepEqual(codeHealth(sample, true).filter(item => item.code === "CG314"), []);
});

test("CG314 still reports empty helpers and unused callbacks", () => {
  const sample = project({
    "assertions.ts": "export function expectNothing(value: number) { return value; } export function expectEqual(actual: number, expected: number) { if (actual !== expected) throw new Error('different'); }",
    "sample_test.ts": "import { expectNothing, expectEqual } from './assertions'; declare function it(name: string, fn: () => void): void; it('noop', () => { expectNothing(42); }); it('unused', () => { const run = () => expectEqual(1, 2); });"
  });
  assert.equal(codeHealth(sample, true).filter(item => item.code === "CG314").length, 2);
});

test("CG314 handles recursive helper calls without assuming an assertion", () => {
  const sample = project({
    "assertions.ts": "export function expectLoop(value: number): number { return expectLoop(value); }",
    "sample_test.ts": "import { expectLoop } from './assertions'; declare function it(name: string, fn: () => void): void; it('no assertion', () => { expectLoop(1); });"
  });
  assert.equal(codeHealth(sample, true).filter(item => item.code === "CG314").length, 1);
});

test("type reuse recognises an existing explicitly implemented interface", async () => {
  const sample = project({
    "contract.ts": "export interface Operation { name: string; run(value: number): number; }",
    "one.ts": "import { Operation } from './contract'; export class Double implements Operation { name = 'double'; run(value: number): number { return value * 2; } }",
    "two.ts": "import { Operation } from './contract'; export class Square implements Operation { name = 'square'; run(value: number): number { return value * value; } }"
  });
  const forbidden: SemanticScorer = async () => { throw new Error("The contract already exists"); };
  assert.deepEqual(await typeReuse(sample, false, forbidden), []);
});

test("type reuse retains independent contracts beyond an implemented interface", async () => {
  const sample = project({
    "contract.ts": "export interface Operation { name: string; run(value: number): number; }",
    "one.ts": "import { Operation } from './contract'; export class Double implements Operation { name = 'double'; run(value: number): number { return value * 2; } retries = 0; timeout = 0; }",
    "two.ts": "import { Operation } from './contract'; export class Square implements Operation { name = 'square'; run(value: number): number { return value * value; } retries = 0; timeout = 0; }"
  });
  const findings = await typeReuse(sample, false, endorse);
  assert.deepEqual(findings.map(item => item.code), ["CG103"]);
  const finding = findings[0] ?? null;
  assert.ok(finding);
  assert.match(finding.reason, /2 independently declared matching field/);
});

test("type reuse does not conflate unrelated structurally identical interfaces", async () => {
  const sample = project({
    "contract.ts": "export interface Operation { name: string; run(value: number): number; }",
    "one.ts": "import { Operation } from './contract'; export class Double implements Operation { name = 'double'; run(value: number): number { return value * 2; } }",
    "two.ts": "export class Square { name = 'square'; run(value: number): number { return value * value; } }"
  });
  const findings = await typeReuse(sample, false, endorse);
  assert.ok(findings.some(item => item.code === "CG103" && item.location.file === "two.ts"));
});

test("CG205 preserves call targets and string literal content in structural comparisons", async () => {
  const sample = project({
    "one.ts": "function calculate(value: number) { return value + 1; } export function alpha(x: number) { const y = calculate(x); const z = y + 2; return z; }",
    "two.ts": "function calculate(value: number) { return value * 2; } export function beta(x: number) { const y = calculate(x); const z = y + 2; return z; }",
    "three.ts": "export function label(x: string) { const y = x + 'a b'; const z = y + '!'; return z; }",
    "four.ts": "export function caption(x: string) { const y = x + 'ab'; const z = y + '!'; return z; }"
  });
  assert.deepEqual((await functionQuality(sample, false, reject)).filter(item => item.code === "CG205"), []);
});

test("CG204 keeps stateless methods required by a declared contract", async () => {
  const sample = project({
    "contract.ts": "export interface Formatter { format(value: string): string; }",
    "formatter.ts": "import { Formatter } from './contract'; export class TextFormatter implements Formatter { format(value: string) { return value.trim(); } extra(value: string) { return value.toLowerCase(); } }"
  });
  const findings = await functionQuality(sample, false, endorse);
  assert.deepEqual(findings.filter(item => item.code === "CG204").map(item => item.subject), ["extra"]);
});

test("CG314 distinguishes actual checks from comments, uncalled callbacks and bare spies", () => {
  const sample = project({
    "sample_test.ts": `
      declare function it(name: string, fn: () => void): void;
      declare function assert(value: boolean): void;
      declare function spyOn(value: object, key: string): void;
      declare function expect(value: number): { toBe(expected: number): void };
      it("comment", () => { /* assert(true) */ Math.round(3); });
      it("unused", () => { const later = () => assert(true); });
      it("spy", () => { spyOn({}, "method"); });
      it("bare expectation", () => { expect(3); });
      it("unreachable", () => { if (false) assert(true); });
      it("matcher", () => { expect(Math.round(3.4)).toBe(3); });
      it("direct", () => { assert(Math.round(3.4) === 3); });
      it("executed helper", () => { const check = () => assert(Math.round(3.4) === 3); check(); });
      it("array callbacks", () => { [2, 3].forEach(value => assert(value > 0)); });
    `
  });
  const findings = codeHealth(sample, true).filter(item => item.code === "CG314");
  assert.equal(findings.length, 5);
  for (const finding of findings) assert.match(finding.subject, /it/);
});

test("CG314 resolves imported assertion aliases and does not trust arbitrary local functions", () => {
  const sample = project({
    "sample_test.ts": `
      import { strictEqual as check } from "node:assert";
      declare function it(name: string, fn: () => void): void;
      function verify(value: number): number { return value; }
      it("alias", () => { check(Math.round(3.4), 3); });
      it("ordinary call", () => { verify(3); });
    `
  });
  const findings = codeHealth(sample, true).filter(item => item.code === "CG314");
  assert.equal(findings.length, 1);
});

test("CG205 retrieves a code candidate without common call names but still requires NLI support", async () => {
  const sample = project({
    "one.ts": "export function first(value: number) { const bounded = Math.max(value, 0); const rounded = Math.round(bounded); return rounded; }",
    "two.ts": "export function second(value: number) { const bounded = value < 0 ? 0 : value; const rounded = Math.floor(bounded + 0.5); return rounded; }"
  });
  const makeExpert = () => new CodeExpert(async () => ({
    embed: async inputs => inputs.map(() => [1, 0]),
    dispose: async () => {}
  }));
  const endorsed = await functionQuality(sample, false, endorse, makeExpert());
  const opposed = await functionQuality(sample, false, reject, makeExpert());
  assert.equal(endorsed.filter(item => item.code === "CG205").length, 1);
  assert.equal(opposed.filter(item => item.code === "CG205").length, 0);
});

test("CG205 does not equate identical bodies with different captured bindings or typed contracts", async () => {
  const sample = project({
    "one.ts": "const offset = 2; export function alpha(x: number) { const y = x + offset; const z = y * 2; return z; }",
    "two.ts": "const offset = 3; export function beta(x: number) { const y = x + offset; const z = y * 2; return z; }",
    "three.ts": "export function first(x: number) { const y = x; const z = y; return z; }",
    "four.ts": "export function second(x: string) { const y = x; const z = y; return z; }"
  });
  assert.deepEqual((await functionQuality(sample, false, reject)).filter(item => item.code === "CG205"), []);
});

test("CG205 supplies typed contracts and behavioural evidence to the final judge", async () => {
  const sample = project({
    "one.ts": "export function alpha(x: number) { const y = Math.round(x); let z = Math.abs(y); z += 1; return z; }",
    "two.ts": "export function beta(x: number) { const y = Math.round(x); let z = Math.abs(y); z += 2; return z; }"
  });
  const evidence: string[] = [];
  const scorer: SemanticScorer = async question => { evidence.push(question.premise); return reject(question); };
  const findings = await functionQuality(sample, false, scorer);
  assert.deepEqual(findings.filter(item => item.code === "CG205"), []);
  assert.ok(evidence.some(item => item.includes("Typed contract: (x: number): number") && item.includes("1 writes") && item.includes("Resolved calls:") && item.includes("z += 2")));
});

test("CG205 does not treat a numeric measurement and boolean predicate as equivalent contracts", async () => {
  const sample = project({
    "one.ts": "export function measure(value: number) { const rounded = Math.round(value); const magnitude = Math.abs(rounded); return magnitude; }",
    "two.ts": "export function check(value: number) { const rounded = Math.round(value); const magnitude = Math.abs(rounded); return magnitude > 2; }"
  });
  const expert = new CodeExpert(async () => ({
    embed: async inputs => inputs.map(() => [1, 0]),
    dispose: async () => {}
  }));
  const result = await functionQuality(sample, false, endorse, expert);
  assert.equal(result.filter(item => item.code === "CG205").length, 0);
});

test("CG202 reviews actual comments and does not treat comment markers inside strings as explanations", async () => {
  const steps = Array.from(Array<number>(28).keys(), i => `if (i === ${i}) { i += 1; }`).join("\n");
  const sample = project({"functions.ts": `export function confusing(i: number) {\nconst url = "https://example.org";\n// Check the condition\n${steps}\nreturn i + url.length;\n}`});
  const seen: string[] = [];
  const scorer: SemanticScorer = async question => {
    seen.push(question.premise);
    return question.same.includes("non-obvious decision or invariant") ? endorse(question) : reject(question);
  };
  assert.ok((await functionQuality(sample, false, scorer)).some(item => item.code === "CG202"));
  assert.ok(seen.some(item => item.includes("Source-located comments: line 3: // Check the condition")));
  assert.ok(seen.every(item => !item.includes("Source-located comments: line 2:")));
});
