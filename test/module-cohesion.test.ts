import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";
import { afterEach, test } from "node:test";
import { loadProject } from "../src/project.ts";
import { moduleCohesion } from "../src/guards/module-cohesion.ts";
import type { SemanticScorer } from "../src/semantic.ts";
import { writeFixture } from "./fixture.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, {recursive: true, force: true});
});

function fixture(sources: Record<string, string>) {
  return loadProject(writeFixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {strict: true, noEmit: true}, include: ["src/**/*.ts", "test/**/*.ts"]
    }),
    ...sources
  }, folders, "module-cohesion-"));
}

const endorse: SemanticScorer = async () => ({sameConcept: 0.96, differentConcept: 0.05});
const reject: SemanticScorer = async () => ({sameConcept: 0.08, differentConcept: 0.96});

test("CG206 uses semantic evidence to identify unrelated module responsibilities and suggest a breakout", async () => {
  const project = fixture({"src/utility.ts": [
    "export function parseRecords(input: string): string[] {",
    "  return input.split(',').map(value => value.trim());",
    "}",
    "export function dispatchAlerts(destination: string, message: string): void {",
    "  console.info(destination, message);",
    "}",
    "export function prepareAlert(text: string): string {",
    "  return text.toUpperCase();",
    "}"
  ].join("\n")});
  const questions: string[] = [];
  const scorer: SemanticScorer = async question => {
    questions.push(question.premise);
    if (question.same.startsWith("this module combines separate operational responsibilities")) return endorse(question);
    if (question.premise.includes("parseRecords") && question.premise.includes("dispatchAlerts")) return endorse(question);
    return reject(question);
  };
  const found = await moduleCohesion(project, false, scorer);
  assert.equal(found.length, 1);
  const finding = found[0] ?? null;
  assert.ok(finding && "related" in finding);
  assert.equal(finding.code, "CG206");
  assert.equal(finding.location.file, "src/utility.ts");
  assert.match(finding.reason, /parseRecords/);
  assert.match(finding.reason, /dispatchAlerts/);
  assert.match(finding.suggestion, /Proposed responsibility breakout/);
  assert.match(finding.suggestion, /module focused on parse records/);
  assert.match(finding.suggestion, /module focused on dispatch alerts/);
  assert.ok(questions.some(question => question.startsWith("TypeScript module")));
  assert.ok(questions.some(question => question.startsWith("Two implementations")));
});

test("CG206 does not treat a long cohesive implementation as a monolith", async () => {
  const helpers = Array.from(Array<number>(80).keys(), i =>
    `export function transformPart${i}(input: string): string {\n  return input.trim().replace(/\\s+/g, " ");\n}`
  );
  const project = fixture({"src/converter.ts": helpers.join("\n")});
  const examined: string[] = [];
  const scorer: SemanticScorer = async question => {
    examined.push(question.premise);
    return reject(question);
  };
  assert.deepEqual(await moduleCohesion(project, false, scorer), []);
  assert.ok(examined.some(value => value.startsWith("TypeScript module")));
  assert.ok(examined.every(value => !value.startsWith("Two implementations")));
});

test("CG206 does not split local helpers from their calling operation", async () => {
  const project = fixture({"src/formatter.ts": [
    "function normalise(value: string): string { return value.trim(); }",
    "export function format(value: string): string { return normalise(value).toUpperCase(); }"
  ].join("\n")});
  const noScoring: SemanticScorer = async () => {throw new Error("A directly related pair needs no NLP");};
  assert.deepEqual(await moduleCohesion(project, false, noScoring), []);
});

test("CG206 honours contradictory evidence and does not demand separation", async () => {
  const project = fixture({"src/coordinator.ts": [
    "export function checkData(input: string): boolean { return input.length > 0; }",
    "export function saveData(input: string): void { console.log(input); }"
  ].join("\n")});
  const scores: SemanticScorer = async () => ({sameConcept: 0.97, differentConcept: 0.86});
  assert.deepEqual(await moduleCohesion(project, false, scores), []);
});

test("CG206 ignores barrel-only modules with no executable responsibilities", async () => {
  const project = fixture({
    "src/one.ts": "export type One = {id: string};",
    "src/two.ts": "export type Two = {date: number};",
    "src/index.ts": "export type {One} from './one.ts';\nexport type {Two} from './two.ts';"
  });
  const noScoring: SemanticScorer = async () => {throw new Error("A barrel has no operational responsibilities");};
  assert.deepEqual(await moduleCohesion(project, false, noScoring), []);
});

test("CG206 excludes tests unless requested and supports class-based responsibilities", async () => {
  const project = fixture({"test/operations.test.ts": [
    "export class InputProcessor { parse(value: string): string[] { return value.split(','); } }",
    "export class EmailSender { send(message: string): void { console.log(message); } }"
  ].join("\n")});
  const noScoring: SemanticScorer = async () => {throw new Error("Tests should not be scanned by default");};
  assert.deepEqual(await moduleCohesion(project, false, noScoring), []);
  const found = await moduleCohesion(project, true, endorse);
  assert.equal(found.length, 1);
  const finding = found[0] ?? null;
  assert.ok(finding);
  assert.match(finding.suggestion, /InputProcessor/);
  assert.match(finding.suggestion, /EmailSender/);
});


test("CG206 inspects top-level script operations without requiring exported functions", async () => {
  const project = fixture({"src/runner.ts": [
    "import {readFileSync} from 'node:fs';",
    "import {createHash} from 'node:crypto';",
    "const records = readFileSync('records.txt', 'utf8');",
    "const digest = createHash('sha256');",
    "console.log(records, digest);"
  ].join("\n")});
  const seen: string[] = [];
  const scorer: SemanticScorer = async question => {
    seen.push(question.premise);
    if (question.premise.startsWith("TypeScript module")) return endorse(question);
    const distinctInitialisers = question.premise.includes("initialisation of records") &&
      question.premise.includes("initialisation of digest");
    return distinctInitialisers ? endorse(question) : reject(question);
  };
  const found = await moduleCohesion(project, false, scorer);
  assert.equal(found.length, 1);
  const finding = found[0] ?? null;
  assert.ok(finding);
  assert.match(finding.suggestion, /initialisation of records/);
  assert.match(finding.suggestion, /initialisation of digest/);
  assert.ok(seen.some(item => item.startsWith("TypeScript module")));
  assert.ok(seen.some(item => item.startsWith("Two implementations") && item.includes("initialisation of records") && item.includes("initialisation of digest")));
});


test("CG206 represents operations across the entire file rather than only the opening", async () => {
  const helpers = Array.from(Array<number>(26).keys(), i =>
    `export function dataStep${i}(value: string): string { return value.trim(); }`
  );
  const project = fixture({"src/pipeline.ts": [
    ...helpers,
    "export function deliverNotification(address: string): void { console.log(address); }"
  ].join("\n")});
  const premises: string[] = [];
  const scorer: SemanticScorer = async question => {
    premises.push(question.premise);
    return reject(question);
  };
  assert.deepEqual(await moduleCohesion(project, false, scorer), []);
  const initial = premises.find(text => text.startsWith("TypeScript module")) ?? "";
  assert.ok(initial.includes("dataStep0"));
  assert.ok(initial.includes("deliverNotification"), "the module overview must include the end of a large file");
});
