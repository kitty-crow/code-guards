import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { documentation } from "../src/guards/documentation.ts";
import { enterpriseLookingNaming } from "../src/guards/enterprise-looking-naming.ts";
import { renderFindings } from "../src/diagnostics.ts";
import { loadProject } from "../src/project.ts";
import type { SemanticScorer } from "../src/semantic.ts";

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
const reject: SemanticScorer = async () => ({ sameConcept: 0.01, differentConcept: 0.99 });

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "code-guards-naming-"));
  temporary.push(root);
  const contents = { "tsconfig.json": JSON.stringify({compilerOptions: {strict: true, noEmit: true, target: "ES2022"}, include: ["src/**/*.ts", "test/**/*.ts"]}), "src/__fixture.ts": "export {};", ...files };
  for (const [relative, text] of Object.entries(contents)) {
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), {recursive: true});
    writeFileSync(filename, text);
  }
  return loadProject(root);
}

const codes = (findings: { code: string }[]) => new Set(findings.map(finding => finding.code));

test("overdescriptive function names suggest a concise abbreviation", () => {
  const project = fixture({ "src/index.ts": "export function veryLongNamesThatAreVerySpecificAndMightNeedShortening(): void {}" });
  const findings = enterpriseLookingNaming(project);
  assert.ok(codes(findings).has("CG316"));
  assert.ok(codes(findings).has("CG317"));
  assert.ok(findings.some(finding => finding.suggestion?.includes("`lngNms`")));
  assert.ok(findings.every(finding => finding.location.file === "src/index.ts"));
});

test("naming guard covers classes, methods, variables, parameters, properties, types, namespaces and aliases", () => {
  const project = fixture({
    "src/source.ts": "export const veryLongAndUnnecessarilySpecificCustomerInformationStorageProvider = 1;",
    "src/index.ts": `
      import { veryLongAndUnnecessarilySpecificCustomerInformationStorageProvider as excessivelyVerboseCustomerInformationServiceProviderManager } from './source';
      export namespace HighlySpecificDataOperationManagerServiceImplementation { export const v = 1; }
      export interface VeryLongAndOverlySpecificCustomerInformationDataTransferRecord { value: number }
      export class CustomerDataValidationServiceManagerFactoryImplementation {
        excessivelyVerboseCustomerInformationProcessingHandlerService(value: number): number { return value; }
      }
      export const object = { excessivelyVerboseCustomerInformationProcessingManagerService: 1 };
      export function check(excessivelyVerboseCustomerInformationProcessingManagerService: string): string {
        const excessivelyVerboseCustomerInformationStorageManagerService = '';
        return excessivelyVerboseCustomerInformationStorageManagerService + excessivelyVerboseCustomerInformationProcessingManagerService;
      }
    `
  });
  const names = new Set(enterpriseLookingNaming(project).filter(item => item.code === "CG316" || item.code === "CG317").map(item => item.subject));
  for (const name of [
    "CustomerDataValidationServiceManagerFactoryImplementation",
    "excessivelyVerboseCustomerInformationProcessingHandlerService",
    "excessivelyVerboseCustomerInformationStorageManagerService",
    "excessivelyVerboseCustomerInformationProcessingManagerService",
    "VeryLongAndOverlySpecificCustomerInformationDataTransferRecord",
    "HighlySpecificDataOperationManagerServiceImplementation",
    "excessivelyVerboseCustomerInformationServiceProviderManager"
  ]) assert.ok(names.has(name), `missing declaration ${name}`);
  const importedOriginal = enterpriseLookingNaming(project).filter(item => item.subject === "veryLongAndUnnecessarilySpecificCustomerInformationStorageProvider");
  assert.equal(new Set(importedOriginal.map(item => `${item.location.file}:${item.location.line}:${item.location.column}`)).size, 1, "unaliased references must not multiply declaration findings");
});

test("naming guard reports path segments once, not once per file within the directory", () => {
  const project = fixture({
    "src/customer-profile-service-manager-controller-implementation/short.ts": "export const ok = true;",
    "src/customer-profile-service-manager-controller-implementation/other.ts": "export const fine = 2;",
    "src/very-long-enterprise-naming-generated-service-name.ts": "export const ready = 1;"
  });
  const paths = enterpriseLookingNaming(project).filter(item => item.code === "CG318");
  assert.equal(paths.length, 2);
  assert.ok(paths.every(item => item.suggestion?.includes("Update imports")));
  const output = renderFindings(paths, {root: project.root, format: "text", colour: "never"});
  assert.match(output, /Path/);
  assert.doesNotMatch(output, /Clause/);
});

test("short expressive names and common abbreviations are allowed, including acronyms", () => {
  const project = fixture({"src/http-req.ts": `
    export const lngNms = 1;
    export class HttpReq { fetchURL(): void {} }
    export function parseCfg(httpReq: string): string { return httpReq; }
    export interface APIResponse { status: number }
  `});
  assert.deepEqual(enterpriseLookingNaming(project), []);
});

test("test declarations are excluded by default and included on request", () => {
  const project = fixture({"test/a.test.ts": "export function anExtremelySpecificFunctionNameWithExcessiveDetail() {}"});
  assert.deepEqual(enterpriseLookingNaming(project), []);
  assert.ok(enterpriseLookingNaming(project, true).some(item => item.code === "CG316"));
});

test("generated code is excluded from the naming audit", () => {
  const project = fixture({"src/generated/SomeVeryLongEnterpriseLookingClassManagerServiceImplementation.ts": "export class SomeVeryLongEnterpriseLookingClassManagerServiceImplementation {}"});
  assert.deepEqual(enterpriseLookingNaming(project), []);
});

test("enterprise-looking-naming strict CLI fails, advisory passes, and disable restores the default", () => {
  const project = fixture({"src/example.ts": "export function veryLongNamesThatAreVerySpecificAndMightNeedShortening() {}"});
  const executable = path.resolve("dist/src/cli.js");
  const launch = (args: string[]) => spawnSync(process.execPath, [executable, ...args, "--path", project.root, "--colour", "never"], {encoding: "utf8"});
  const advisory = launch(["enterprise-looking-naming"]);
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.match(advisory.stdout, /WARNING\s+CG316/);
  assert.match(advisory.stdout, /Fix/);
  const strict = launch(["enterprise-looking-naming", "--strict"]);
  assert.equal(strict.status, 1, strict.stderr);
  const disabled = launch(["enterprise-looking-naming", "--strict", "--disable", "enterprise-looking-naming"]);
  assert.equal(disabled.status, 0, disabled.stderr);
});

test("CG404 catches disguised development summaries but keeps literal prompt detection separate", async () => {
  const project = fixture({"README.md": `# Usage

This library now performs this action rather than that action.

We have introduced a new system for validating requests.

The app has been updated to handle configuration.

It now supports faster data loading.

You are an expert developer and your task is to produce better code.
`});
  const issues = await documentation(project, reject);
  assert.equal(issues.filter(item => item.code === "CG404").length, 4);
  assert.equal(issues.filter(item => item.code === "CG405").length, 1);
  assert.ok(issues.filter(item => item.code === "CG404").every(item => item.reason?.includes("development summary")));
});

test("CG404 ignores release history, fenced examples and useful current-behaviour descriptions", async () => {
  const project = fixture({
    "README.md": `# Usage

The library reads a TypeScript configuration and prints diagnostics with source locations.

Unlike a hosted inference service, classification runs locally without uploading source code.

\`\`\`md
This library now performs this action rather than that action.
\`\`\`

## Changelog

This library now performs X rather than Y.

### Version 2

We have introduced a new command.

## Usage details

The command reports errors and exits 1 in strict mode.
`,
    "CHANGELOG.md": "# Changes\n\nThe library now performs X rather than Y.\n"
  });
  assert.ok(!(await documentation(project, reject)).some(item => item.code === "CG404"));
});

test("CG404 flags a disguised feature claim in module docs with a concrete rewrite", async () => {
  const project = fixture({"docs/modules/utils.md": "# Utilities\n\nThe module now provides an enhanced interface instead of older functionality.\n"});
  const issues = await documentation(project, reject);
  const warning = issues.find(item => item.code === "CG404");
  assert.equal(warning?.location.file, "docs/modules/utils.md");
  assert.match(warning?.suggestion ?? "", /working command, API, inputs\/outputs/);
});
