import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codeHealth } from "../src/guards/code-health.ts";
import { loadProject } from "../src/project.ts";
import { run } from "../src/cli.ts";

function fixture(source: string, callback: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "guard-types-"));
  try {
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false, target: "ES2022", noEmit: true }, files: ["input.ts"] }));
    writeFileSync(join(root, "input.ts"), source);
    callback(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function findings(source: string): string[] {
  const result: string[] = [];
  fixture(source, root => {
    result.push(...codeHealth(loadProject(root), true).filter(item => item.code === "CG305").map(item => item.message));
  });
  return result;
}

test("CG305 catches forbidden explicit and inferred types", () => {
  const cases = [
    "let value: any = 0;",
    "let value: unknown = 0;",
    "let value: string | undefined;",
    "interface Item { value?: string; }",
    "function pick(value?: string): string { return value ?? ''; }",
    "const value = undefined;",
    "const value = void 0;",
    "const value = undefined ?? 1;",
    "const value = JSON.parse('{}') ?? 1;",
    "const value = JSON.parse('{}');",
    "JSON.parse('{}');",
    "function parse() { return JSON.parse('{}'); }",
    "async function parse() { return JSON.parse('{}'); }",
    "function use(value) { return value; }",
    "function read(): void { try { throw new Error('x'); } catch (error) { console.log(error); } }",
    "const entries: string[] = []; const value = entries[0];",
    "const entries = new Map<string, number>(); const value = entries.get('x');",
    "let value: Promise<any>;",
    "type Alias = unknown; let value: Alias;",
    "function pick(value: string | null) { return value?.length; }",
    "const value = 0 as any;",
    "let value!: number;",
    "const value: number | null = null; const result = value!;"
  ];
  for (const source of cases) assert.ok(findings(source).length > 0, source);
});

test("CG305 accepts concrete and explicitly nullable contracts", () => {
  const source = `
    type Value = { kind: "absent" } | { kind: "present"; value: number };
    function choose(found: boolean): Value {
      return found ? { kind: "present", value: 1 } : { kind: "absent" };
    }
    function text(input: string | null): string { return input === null ? "" : input; }
    function consume(): void { console.log(text("ok")); }
    function read(): string {
      try { return text("ok"); }
      catch (error) { return error instanceof Error ? error.message : "Unexpected error"; }
    }
    const keys = { any: 1, unknown: 2, undefined: 3 };
    const result = keys.undefined;
    const tuple = [1, 2] as const;
    const present = tuple[0];
    function identity<T>(value: T): T { return value; }
    const number = identity(3);
    const missing = new Map<string, number>().get('x') ?? null;
    new Map<string, number>().get('discarded');
    const indexed = [1, 2][5] ?? 0;
    const lookup: Record<string, string> = {};
    delete lookup.old;
  `;
  assert.deepEqual(findings(source), []);
});

test("strict CLI fails on CG305 while advisory mode remains non-blocking", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-strict-"));
  try {
    const file = join(root, "input.ts");
    writeFileSync(file, "export const value = JSON.parse('{}');");
    assert.equal(await run(["type-assertions", "--path", file, "--format", "json"]), 0);
    assert.equal(await run(["type-assertions", "--path", file, "--strict", "--format", "json"]), 1);
    writeFileSync(file, "export const value = 3;");
    assert.equal(await run(["type-assertions", "--path", file, "--strict"]), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("expectation directives suppress findings and enforce missing diagnostics in both modes", async () => {
  const marker = "//" + "@cg-expect-";
  const root = mkdtempSync(join(tmpdir(), "guard-expect-"));
  try {
    const file = join(root, "input.ts");
    const scan = (strict: boolean): Promise<number> => run(["type-assertions", "--path", file, ...(strict ? ["--strict"] : []), "--format", "json"]);
    for (const kind of ["error", "warning"]) {
      writeFileSync(file, marker + kind + "\nconst value: any = 1;\n");
      assert.equal(await scan(false), 0);
      assert.equal(await scan(true), 0);
      writeFileSync(file, marker + kind + "\nconst value: number = 1;\n");
      assert.equal(await scan(false), kind === "error" ? 1 : 0);
      assert.equal(await scan(true), 1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CG305 reports an inferred loose initializer at its origin", () => {
  assert.equal(findings("const parsed = JSON.parse('{}');").length, 1);
  assert.equal(findings("const values: number[] = []; const item = values[0];").length, 1);
  assert.ok(findings("const values: number[][] = []; const item = values[0][1];").length >= 2);
});

test("CG305 accepts bounded dense literal and typed array reads", () => {
  assert.deepEqual(findings("const x = [1, 2][1];"), []);
  assert.deepEqual(findings("function total(values: Float32Array): number { let sum = 0; for (let i = 0; i < values.length; i++) { const value = values[i]; sum += value; } return sum; }"), []);
});

test("CG305 retains checks for sparse, unbounded, or invalidated reads", () => {
  const cases = [
    "const x = [1, , 3][1];",
    "const x = [1, 2][3];",
    "function f(a: number[]): number { let sum = 0; for (let i = 0; i < a.length; i++) { sum += a[i]; } return sum; }",
    "function f(a: Float32Array): number { let sum = 0; for (let i = 0; i <= a.length; i++) { sum += a[i]; } return sum; }",
    "function f(a: Float32Array): number { let sum = 0; for (let i = 0; i < a.length; i++) { i += 2; sum += a[i]; } return sum; }",
    "function f(a: Float32Array): number { let sum = 0; for (let i = 0; i < a.length; i++) { a = new Float32Array(0); sum += a[i]; } return sum; }"
  ];
  for (const source of cases) assert.ok(findings(source).length > 0, source);
});
