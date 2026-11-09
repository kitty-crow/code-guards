import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { noNestedIf } from "../src/guards/no-nested-if.ts";
import { typeReuse } from "../src/guards/type-reuse.ts";
import { loadProject } from "../src/project.ts";

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

test("nested if and else if fail, but an adjacent guard clause passes", () => {
  const sample = project({ "one.ts": `
    function nested(a: boolean, b: boolean) {
      if (a) { if (b) return; } else if (b) return;
      if (!a) return;
      if (!b) return;
    }
  ` });
  const result = noNestedIf(sample);
  assert.equal(result.length, 2);
  assert.ok(result.every(finding => finding.code === "CG001"));
});

test("a nested function resets control-flow nesting", () => {
  const sample = project({ "one.ts": `
    function outer(a: boolean) {
      if (a) { const inner = () => { if (a) return; }; inner(); }
    }
  ` });
  assert.equal(noNestedIf(sample).length, 0);
});

test("matching types across files are reported regardless of property order", () => {
  const sample = project({
    "one.ts": "export interface EnquiryContact { name: string; email: string | null; company?: string }",
    "two.ts": "export type ProjectContact = { company?: string; email: string | null; name: string };"
  });
  const result = typeReuse(sample);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.code, "CG101");
});

test("similar field names and concepts are an informational suggestion", () => {
  const sample = project({
    "one.ts": "export interface Customer { name: string; email: string }",
    "two.ts": "export interface Client { fullName: string; emailAddress: string }"
  });
  const result = typeReuse(sample);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.code, "CG103");
  assert.equal(result[0]?.severity, "info");
});

test("primitive and collection aliases do not get reported as duplicates", () => {
  const sample = project({
    "one.ts": "export type Person = string | null;",
    "two.ts": "export type People = (string | null)[];"
  });
  assert.equal(typeReuse(sample).length, 0);
});

test("unrelated classes with similar shapes are never marked exact duplicates", () => {
  const sample = project({
    "one.ts": "export class BillingAddress { street = ''; city = ''; }",
    "two.ts": "export class ShippingAddress { street = ''; city = ''; }"
  });
  assert.ok(typeReuse(sample).every(item => item.code !== "CG101"));
});

test("test files are excluded from type reuse by default", () => {
  const sample = project({
    "src/a.ts": "export type A = { id: number; name: string }",
    "test/b.test.ts": "export type B = { id: number; name: string }"
  });
  assert.equal(typeReuse(sample).length, 0);
  assert.equal(typeReuse(sample, true).length, 1);
});


test("string literal unions must not be compared as record declarations", () => {
  const sample = project({
    "one.ts": "export type Severity = 'error' | 'warning' | 'info';",
    "two.ts": "export type Mode = 'open' | 'closed' | 'pending';"
  });
  assert.equal(typeReuse(sample).length, 0);
});
