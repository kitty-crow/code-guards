import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { loadProject } from "../src/project.ts";
import { codeHealth } from "../src/guards/code-health.ts";
import { crossModule } from "../src/guards/cross-module.ts";
import { documentation } from "../src/guards/documentation.ts";
import { repoHygiene } from "../src/guards/repo-hygiene.ts";
import type { SemanticScorer } from "../src/semantic.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "guards-housekeeping-"));
  directories.push(root);
  const all = {"tsconfig.json": JSON.stringify({compilerOptions: {strict: true, noEmit: true}, include: ["src/**/*.ts", "test/**/*.ts"]}), "src/__fixture.ts": "export {};", ...files};
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    writeFileSync(path.join(root, file), content);
  }
  return loadProject(path.join(root, "tsconfig.json"));
}

const reject: SemanticScorer = async () => ({sameConcept: 0.03, differentConcept: 0.96});
const endorse: SemanticScorer = async () => ({sameConcept: 0.95, differentConcept: 0.04});
const codes = (items: {code: string}[]): Set<string> => new Set(items.map(item => item.code));

test("compiler checks: dead code, boolean simplification, unsafe async, casts, switch and mutable binding", () => {
  const project = fixture({"src/one.ts": `
    export function expired(): number { return 1; console.log('unreachable'); }
    export function verify(ok: boolean): boolean { if (ok) {return true;} else {return false;} }
    async function request(): Promise<void> { return; }
    export function launch(): void { request(); try { throw Error('bad'); } catch {} }
    export function force(item: string | undefined): string { return item! as any; }
    export function choose(state: 'open' | 'closed'): void { switch (state) { case 'open': return; } }
    export function variable(): number { let count = 1; return count; }
  `});
  const actual = codes(codeHealth(project));
  for (const code of ["CG301", "CG302", "CG303", "CG305", "CG306", "CG313"]) assert.ok(actual.has(code), `missing ${code}`);
});

test("design checks: responsibility, wrapper, names, contracts, placeholders, tests and coupling", () => {
  const dependencies = Array.from({length: 10}, (_, i) => `import { value${i} } from './dep${i}.ts';`).join("\n");
  const modules = Object.fromEntries(Array.from({length: 10}, (_, i) => [`src/dep${i}.ts`, `export const value${i} = ${i};`]));
  const project = fixture({
    ...modules,
    "src/core.ts": `
       ${dependencies}
       export function doStuff(a: number, b: number, c: number, d: number, e: number, f: number, g: number) { return a+b+c+d+e+f+g; }
       export function notReady(): void { /* TODO: implement this */ }
       export function called(value: number): number { return value+1; }
       export class TooMuch {
         forward(value: number): number { return called(value); }
         misplaced(value: number): number {
           const a = Math.round(value);
           const b = Math.floor(value);
           const c = Math.ceil(value);
           const d = Math.abs(value);
           const e = Math.trunc(value);
           const f = Math.min(value, 3);
           const g = Math.max(value, 6);
           const h = Math.sign(value);
           const i = Math.sqrt(Math.abs(value));
           const j = Math.pow(value, 2);
           const k = Number.isFinite(value) ? value : 0;
           const l = a + b + c + d;
           return l + e + f + g + h + i + j + k;
         }
       }
    `,
    "test/empty.test.ts": `import { test } from 'node:test'; test('pointless', () => { Math.round(2); });`
  });
  const actual = codes(codeHealth(project));
  for (const code of ["CG307", "CG308", "CG310", "CG311", "CG312", "CG314", "CG315"]) assert.ok(actual.has(code), `missing ${code}`);
});

test("cross-module checks detect repeated values and bypassing the established API client", () => {
  const project = fixture({
    "src/client.ts": `export const apiClient = (url: string): Promise<Response> => fetch(url); export const customerEndpoint = 'https://example.com/api/customers';`,
    "src/other.ts": `export const customerEndpointUrl = 'https://example.com/api/customers'; export function direct(): Promise<Response> { return fetch('https://example.com'); }`
  });
  const actual = codes(crossModule(project));
  assert.ok(actual.has("CG304"));
  assert.ok(actual.has("CG309"));
});

test("documentation guard points to missing README, index and per-module pages", async () => {
  const project = fixture({"src/service.ts": "export function serve(value: string): string { return value; }"});
  const findings = await documentation(project, reject);
  for (const code of ["CG400", "CG407", "CG408"]) assert.ok(codes(findings).has(code));
  assert.ok(findings.find(item => item.code === "CG408" && item.location.file === "src/service.ts")?.suggestion?.includes("docs/modules/service.md"));
});

test("documentation checks missing exports, stale commands, broken links and incomplete claims", async () => {
  const project = fixture({
    "package.json": JSON.stringify({scripts: {start: "echo ready"}}),
    "README.md": "# Demo\n\nInstall with `bun run start`.\n\nUse `bun run deploy` after setup. See [instructions](docs/nowhere.md) and [modules](docs/index.md).",
    "src/service.ts": "export function serve(value: string): string { /* TODO: implement */ return value; }",
    "docs/index.md": "# Modules\n\n[Service](modules/service.md)",
    "docs/modules/service.md": "# Service\n\nThis module is fully implemented and ready for use. It handles service requests and processes input through a normalised flow. It supports clients and exposes configuration that can be used across the application."
  });
  const findings = await documentation(project, reject);
  const actual = codes(findings);
  for (const code of ["CG406", "CG409", "CG412", "CG413"]) assert.ok(actual.has(code), `missing ${code}`);
});

test("documentation warnings catch prompt leakage, marketing and repeated paragraphs", async () => {
  const repeat = "This service checks every command against the package scripts before executing a local validation run.";
  const project = fixture({"README.md": `# Intro\n\nYou are an expert developer and your task is to write a wonderful application.\n\nOur tool is a revolutionary and powerful solution for your next project.\n\n${repeat}\n\n${repeat}\n\n\`bun run ci\``, "package.json": JSON.stringify({scripts: {ci: "echo ok"}})});
  const actual = codes(await documentation(project, reject));
  for (const code of ["CG401", "CG403", "CG405"]) assert.ok(actual.has(code));
});

test("semantic documentation review invokes a real scorer interface only for shortlisted vague prose", async () => {
  const project = fixture({"README.md": "# Intro\n\nThis tool provides a highly flexible experience for teams and maintains useful functionality through a modern solution for codebases that developers may need to update."});
  let requests = 0;
  const score: SemanticScorer = async question => { requests += 1; assert.match(question.premise, /Documentation paragraph/); return endorse(question); };
  const actual = codes(await documentation(project, score));
  assert.ok(requests > 0);
  assert.ok(actual.has("CG410"));
  assert.ok(!codes(await documentation(project, reject)).has("CG410"));
});

test("housekeeping detects repeated CI steps and identical test scripts", () => {
  const project = fixture({"package.json": JSON.stringify({scripts: {ci: "tsc && tsc", "test:one": "bun test", "test:two": "bun test"}})});
  const actual = codes(repoHygiene(project.root));
  assert.ok(actual.has("CG501"));
  assert.ok(actual.has("CG502"));
});

test("clean internal module docs and established scripts produce no housekeeping findings", async () => {
  const project = loadProject(path.resolve("tsconfig.json"));
  assert.deepEqual(await documentation(project, reject), []);
  assert.deepEqual(repoHygiene(project.root), []);
});
