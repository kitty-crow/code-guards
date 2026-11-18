import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { reviewPractices } from "../src/guards/review-practices.ts";
import { loadProject } from "../src/project.ts";
import { writeFixture } from "./fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function project(files: Record<string, string>) {
  return loadProject(writeFixture({
    "tsconfig.json": JSON.stringify({compilerOptions: {strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true}, include: ["src/**/*.ts", "test/**/*.ts"]}),
    ...files
  }, roots, "guards-review-"));
}
const codes = (items: {code: string}[]): Set<string> => new Set(items.map(item => item.code));

test("narrated comments are identified, but reasons and invariants are not", () => {
  const sample = project({"src/loop.ts": `
    export function count(users: string[]): number {
      let total = 0;
      // Loop through the users and check each one
      for (const user of users) total += user.length;
      // Preserve the source order because the external report is positional.
      for (const user of users) total += user.length;
      return total;
    }
  `});
  const results = reviewPractices(sample).filter(item => item.code === "CG319");
  assert.equal(results.length, 1);
  const finding = results[0] ?? null;
  assert.ok(finding);
  assert.match(finding.reason, /Loop through the users/);
});

test("unavailable API members are tied to TypeScript diagnostics rather than guessed", () => {
  const sample = project({"src/api.ts": `
    interface Client { request(): number }
    declare const client: Client;
    export const output = client.requestNonexistentAction();
  `});
  const results = reviewPractices(sample).filter(item => item.code === "CG320");
  assert.equal(results.length, 1);
  const finding = results[0] ?? null;
  assert.ok(finding);
  assert.match(finding.reason, /TS2339/);
  assert.match(finding.suggestion, /installed dependency version/);
});

test("convention warnings require a prevailing style", () => {
  const sample = project({"src/styles.ts": `
    export function parseDate() { return 1; }
    export function renderDate() { return 2; }
    export const cacheCount = 3;
    export function write_date() { return 4; }
  `});
  const results = reviewPractices(sample).filter(item => item.code === "CG321");
  assert.equal(results.length, 1);
  const finding = results[0] ?? null;
  assert.ok(finding);
  assert.match(finding.subject, /write_date/);
  const mixed = project({"src/mixed.ts": "export function parseDate() { return 1; } export function write_date() { return 2; }"});
  assert.ok(!codes(reviewPractices(mixed)).has("CG321"));
});

test("long copied statement runs are reported across different implementations", () => {
  const common = `
    const normalised = String(input).trim().toLowerCase();
    const sections = normalised.split(',').map(part => part.trim());
    const filtered = sections.filter(part => part.length > 3);
  `;
  const sample = project({
    "src/one.ts": `export function first(input: string): string { ${common} return filtered.join('|'); }`,
    "src/two.ts": `export function second(input: string): number { ${common} return filtered.length; }`
  });
  const results = reviewPractices(sample).filter(item => item.code === "CG322");
  assert.equal(results.length, 1);
  const finding = results[0] ?? null;
  assert.ok(finding && "related" in finding);
});

test("bare rethrows are flagged but recovery handlers are retained", () => {
  const sample = project({"src/errors.ts": `
    export function redundant(): number { try { return 1; } catch (error) { throw error; } }
    export function recover(): number { try { return 1; } catch { return 0; } }
  `});
  assert.equal(reviewPractices(sample).filter(item => item.code === "CG323").length, 1);
});

test("tautological assertions are flagged even though tests contain assertions", () => {
  const sample = project({"test/weak.test.ts": `
    declare const test: (name: string, fn: () => void) => void;
    declare const assert: {ok(value: unknown): void; equal(left: unknown, right: unknown): void};
    declare const expect: (value: unknown) => {toBe(value: unknown): void; toBeTruthy(): void};
    test('weak', () => { assert.ok(true); assert.equal(1, 1); expect(true).toBe(true); expect(true).toBeTruthy(); });
  `});
  assert.equal(reviewPractices(sample).filter(item => item.code === "CG324").length, 4);
});

test("stateless class shells and mixed date-formatters get review suggestions", () => {
  const sample = project({"src/format.ts": `
    export class PriceFormattingManager { format(price: number) { return price.toFixed(2); } }
    export class Stateful { value = 1; get() { return this.value; } }
    export function dates(date: Date): string[] { return [date.toLocaleDateString(), new Intl.DateTimeFormat('en-GB').format(date)]; }
  `});
  const results = codes(reviewPractices(sample));
  assert.ok(results.has("CG325"));
  assert.ok(results.has("CG326"));
});

test("clean code with meaningful comments, assertions and API calls produces no review findings", () => {
  const sample = project({
    "src/clean.ts": `
      export class Client { private requests = 0; run() { this.requests += 1; return this.requests; } }
      export function check(users: string[]): number {
        let total = 0;
        // The threshold is defined by the provider's documented protocol.
        for (const user of users) total += user.length;
        return total;
      }
      export function normal(date: Date): string { return new Intl.DateTimeFormat('en-GB').format(date); }
    `,
    "test/valid.test.ts": `
      declare function test(name: string, callback: () => void): void;
      declare const assert: {equal(x: unknown, y: unknown): void};
      test('meaningful', () => { assert.equal(2 + 2, 4); });
    `
  });
  assert.deepEqual(reviewPractices(sample), []);
});

test("review-practices advisory and strict modes return correct exit codes", () => {
  const sample = project({"src/api.ts": "declare const service: { run(): void }; service.notARealMethod();"});
  const command = [path.resolve("dist/src/cli.js"), "review-practices", "--path", sample.root, "--colour", "never"];
  const normal = spawnSync(process.execPath, command, {encoding: "utf8"});
  const strict = spawnSync(process.execPath, [...command, "--strict"], {encoding: "utf8"});
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stdout, /CG320/);
});
