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
    "const value = JSON.parse('{}');",
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
    const keys = { any: 1, unknown: 2, undefined: 3 };
    const result = keys.undefined;
    const tuple = [1, 2] as const;
    const present = tuple[0];
    function identity<T>(value: T): T { return value; }
    const number = identity(3);
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
