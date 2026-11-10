import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
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

// The example must compile independently of the caller's ambient Node type tree.
test("housekeeping showcase compiles with portable module resolution", () => {
  const config = path.resolve("examples/housekeeping/tsconfig.json");
  const result = spawnSync("tsc", ["-p", config, "--pretty", "false"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("CG411 uses semantic evidence, not README keywords or repository names", async () => {
  const project = fixture({"README.md": "# Usage\n\nThe implementation was prepared for delivery and the integration suite could not be executed in the development environment.\n\nRun npm test to exercise the source package."});
  const premises: string[] = [];
  const scorer: SemanticScorer = async question => {
    premises.push(question.premise);
    return question.premise.includes("prepared for delivery")
      ? {sameConcept: 0.875, differentConcept: 0.332}
      : {sameConcept: 0.05, differentConcept: 0.95};
  };
  const findings = await documentation(project, scorer);
  assert.ok(premises.some(text => text.includes("prepared for delivery")));
  assert.ok(premises.some(text => text.includes("Run npm test")));
  assert.equal(findings.filter(item => item.code === "CG411").length, 1);
  assert.match(findings.find(item => item.code === "CG411")?.suggestion ?? "", /current behaviour/);
});

test("CG411 ignores fenced code and non-README module reference pages", async () => {
  const project = fixture({
    "README.md": "# Usage\n\nRun npm test to execute the local tests.\n\n`\`\`text\nThis paragraph reports the author's coding session.\n`\`\`",
    "docs/modules/module.md": "# Module\n\nThe module scans TypeScript and reports line-numbered results."
  });
  const premises: string[] = [];
  const scorer: SemanticScorer = async question => {
    premises.push(question.premise);
    return {sameConcept: 0.92, differentConcept: 0.2};
  };
  const findings = await documentation(project, scorer);
  assert.ok(premises.some(text => text.includes("Run npm test")));
  assert.ok(premises.every(text => !text.includes("coding session")));
  assert.ok(premises.every(text => !text.includes("module scans TypeScript")));
  assert.equal(findings.filter(item => item.code === "CG411").length, 1);
  assert.equal(findings.find(item => item.code === "CG411")?.location.file, "README.md");
});

test("CG411 respects contradictory semantic evidence despite strong support", async () => {
  const project = fixture({"README.md": "# Usage\n\nThe command accepts --strict and reports structured diagnostics without writing any files."});
  const findings = await documentation(project, async () => ({sameConcept: 0.91, differentConcept: 0.44}));
  assert.ok(!findings.some(item => item.code === "CG411"));
});

test("CG411 does not mistake well-documented stable behaviour for an implementation handover", async () => {
  const project = fixture({"README.md": "# Usage\n\nThe checker reads TypeScript source files, reports warnings by location, and exits 1 under --strict."});
  const findings = await documentation(project, async () => ({sameConcept: 0.3, differentConcept: 0.91}));
  assert.ok(!findings.some(item => item.code === "CG411"));
});


test("CG411 detects an implementation-history-heavy README introduction through NLP", async () => {
  const project = fixture({"README.md": [
    "# Overview",
    "",
    "This program was rewritten from an earlier implementation in a different programming language, and its original source layout was reorganised.",
    "",
    "The new version was assembled using upstream change notes, and several internal routines were replaced during preparation.",
    "",
    "The utility compares repository revisions and produces a summary of changed files."
  ].join("\n")});
  const introductionPremises: string[] = [];
  const scorer: SemanticScorer = async question => {
    if (!question.premise.startsWith("README introduction paragraph:")) return reject(question);
    introductionPremises.push(question.premise);
    return introductionPremises.length <= 2 ? endorse(question) : reject(question);
  };
  const findings = await documentation(project, scorer);
  assert.equal(introductionPremises.length, 3, "each introduction paragraph must be scored independently");
  assert.ok(introductionPremises[0]?.includes("rewritten from an earlier implementation"));
  assert.ok(introductionPremises[1]?.includes("new version was assembled"));
  assert.ok(introductionPremises[2]?.includes("utility compares repository revisions"));
  const introductionFindings = findings.filter(item => item.code === "CG411");
  assert.equal(introductionFindings.length, 1);
  assert.equal(introductionFindings[0]?.location.line, 3);
  assert.match(introductionFindings[0]?.reason ?? "", /lines 3, 5/);
});

test("CG411 does not flag a functional README introduction when NLP opposes the quality concern", async () => {
  const project = fixture({"README.md": [
    "# Introduction",
    "",
    "This command-line utility reads a folder of documents and generates a searchable index.",
    "",
    "Install the dependencies using npm install, then run npm test to verify the package.",
    "",
    "Pass --output with a destination file to write JSON results without modifying the input folder."
  ].join("\n")});
  const findings = await documentation(project, reject);
  assert.ok(!findings.some(item => item.code === "CG411"));
});

test("CG411 rejects contradictory NLP evidence for a multi-paragraph introduction", async () => {
  const project = fixture({"README.md": [
    "# Overview",
    "",
    "The software reads a directory and creates a report.",
    "",
    "Installation uses the package manager and a local configuration file.",
    "",
    "The command prints warnings and returns a nonzero exit status for failures."
  ].join("\n")});
  const findings = await documentation(project, async () => ({sameConcept: 0.96, differentConcept: 0.72}));
  assert.ok(!findings.some(item => item.code === "CG411"));
});

test("routine CI excludes warning-showcase tests but full CI preserves them", () => {
  const packageFile = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {scripts: Record<string, string>};
  const scripts = packageFile.scripts;
  assert.match(scripts["ci:bun"] ?? "", /bun test \.\/test\/\*\.test\.ts/);
  assert.match(scripts["ci:bun"] ?? "", /bun dist\/src\/cli\.js --strict/);
  assert.match(scripts["test:showcase:bun"] ?? "", /bun test \.\/test\/showcase\/\*\.test\.ts/);
  assert.match(scripts["ci:full:bun"] ?? "", /bun test && bun dist\/src\/cli\.js --strict/);
  assert.match(scripts["ci"] ?? "", /node --test dist\/test\/\*\.test\.js/);
  assert.match(scripts["ci:full"] ?? "", /dist\/test\/showcase\/\*\.test\.js/);
});

test("CG411 uses general documentation-quality hypotheses without lexical matching", async () => {
  const project = fixture({"README.md": [
    "# Introduction",
    "",
    "The author spent several iterations replacing an early design and describes the process that led to the current implementation.",
    "",
    "The tool validates data files and emits a report with each record's status.",
    "",
    "The team selected a different architecture while preparing the deliverable, although its effect on users is not explained."
  ].join("\n")});
  const comparisons: {same: string; different: string; premise: string}[] = [];
  const scorer: SemanticScorer = async question => {
    comparisons.push(question);
    if (!question.premise.startsWith("README introduction paragraph:")) return reject(question);
    return question.premise.includes("tool validates data files") ? reject(question) : endorse(question);
  };
  const findings = await documentation(project, scorer);
  const introduction = comparisons.filter(question => question.premise.startsWith("README introduction paragraph:"));
  assert.equal(introduction.length, 3);
  assert.ok(introduction.every(question => question.same.includes("author") && question.different.includes("readers")));
  assert.ok(findings.some(finding => finding.code === "CG411" && finding.message.includes("introduction")));
});

test("CG411 reviews individual sentences for formulaic cadence even within a practical paragraph", async () => {
  const project = fixture({"README.md": [
    "# Introduction",
    "",
    "The converter accepts plain text files and produces an index. The implementation is delivered as a distinct arrangement, for reasons associated with the team's preparation process."
  ].join("\n")});
  const seen: string[] = [];
  const scorer: SemanticScorer = async question => {
    seen.push(question.premise);
    if (question.same.includes("formulaic or overexplained") && question.premise.includes("distinct arrangement")) {
      return {sameConcept: 0.91, differentConcept: 0.12};
    }
    return reject(question);
  };
  const findings = await documentation(project, scorer);
  const issues = findings.filter(item => item.code === "CG411");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.message, "Formulaic or unnecessary wording in documentation");
  assert.match(issues[0]?.subject ?? "", /distinct arrangement/);
  assert.ok(!issues[0]?.subject?.includes("converter accepts"));
  assert.ok(seen.some(premise => premise.includes("Sentence to review:")));
});

test("CG411 editorial review applies to ordinary Markdown documentation, not only README", async () => {
  const project = fixture({"README.md": "# Introduction\n\nThe program accepts JSON files and writes a validated report.",
    "docs/guide.md": "# Guide\n\nThis description exists in the present arrangement solely to reflect the implementation decisions taken during delivery."});
  const scorer: SemanticScorer = async question => question.same.includes("formulaic or overexplained")
    ? {sameConcept: 0.93, differentConcept: 0.14}
    : reject(question);
  const findings = await documentation(project, scorer);
  assert.ok(findings.some(item => item.code === "CG411" && item.location.file === "docs/guide.md"));
});

test("CG411 editorial check requires semantic support and excludes fenced examples", async () => {
  const project = fixture({"README.md": [
    "# Usage", "",
    "The command reads a configuration file, validates the records and exits nonzero if any record is invalid.", "",
    "```text",
    "A deliberately unnatural passage about internal delivery decisions belongs inside this code example.",
    "```"
  ].join("\n")});
  const premises: string[] = [];
  const scorer: SemanticScorer = async question => {
    premises.push(question.premise);
    return {sameConcept: 0.94, differentConcept: 0.69};
  };
  const findings = await documentation(project, scorer);
  assert.ok(!findings.some(item => item.code === "CG411"));
  assert.ok(premises.every(premise => !premise.includes("deliberately unnatural")));
});

test("CG411 identifies sentence boundaries after Markdown emphasis and semicolon qualifications", async () => {
  const project = fixture({"README.md": [
    "# Instructions",
    "",
    "**The importer reads spreadsheet rows.** The output is generated in a distinct form for reasons related to packaging.",
    "",
    "The index can be written as JSON; this extra qualification merely restates a design choice without helping the reader."
  ].join("\n")});
  const excerpts: string[] = [];
  const scorer: SemanticScorer = async question => {
    if (!question.same.includes("formulaic or overexplained")) return reject(question);
    const excerpt = question.premise.split("Sentence to review: ")[1] ?? "";
    excerpts.push(excerpt);
    return excerpt.startsWith("this extra qualification") ? {sameConcept: 0.91, differentConcept: 0.1} : reject(question);
  };
  const findings = await documentation(project, scorer);
  assert.ok(excerpts.some(text => text.startsWith("The output is generated")));
  assert.ok(excerpts.some(text => text.startsWith("this extra qualification")));
  assert.equal(findings.filter(item => item.code === "CG411" && item.message.includes("Formulaic")).length, 1);
});
