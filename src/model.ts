import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const guards = [
  "no-nested-if", "type-reuse", "function-quality", "module-cohesion",
  "dead-code", "simplify-code", "async-safety", "single-source",
  "type-assertions", "state-exhaustiveness", "responsibility",
  "overengineering", "project-conventions", "naming", "coupling",
  "function-contracts", "derived-state", "test-quality",
  "incomplete-implementation", "documentation", "repo-hygiene",
  "enterprise-looking-naming", "review-practices"
] as const;
export type GuardName = typeof guards[number];
export type Severity = "warning" | "info";
export type Location = { file: string; line: number; column: number };
export type Finding = {
  guard: GuardName;
  severity: Severity;
  code: string;
  message: string;
  location: Location;
  subject: string;
  reason: string;
  suggestion: string;
} & (
  | { span: number }
  | { related: Location }
  | { span: number; related: Location }
  | { span: number; similarity: number }
  | { span: number; similarity: number; related: Location; relatedSpan: number }
);

export function location(root: string, node: ts.Node): Location {
  const file = node.getSourceFile();
  const position = file.getLineAndCharacterOfPosition(node.getStart(file));
  return {
    file: path.relative(root, file.fileName).split(path.sep).join("/"),
    line: position.line + 1,
    column: position.character + 1
  };
}

function ignoredLines(root: string, file: string): Set<number> {
  const lines = new Set<number>();
  let source: string;
  try { source = readFileSync(path.resolve(root, file), "utf8"); }
  catch { return lines; }
  for (const [index, line] of source.split(/\r\n|\n|\r/).entries()) {
    if (/^\s*\/\/@cg-ignore\s*$/.test(line)) lines.add(index + 2);
  }
  return lines;
}

/** Suppress diagnostics whose primary location is exactly one line after a directive. */
export function withoutIgnored(root: string, findings: Finding[]): Finding[] {
  const cache = new Map<string, Set<number>>();
  return findings.filter(finding => {
    const { file, line } = finding.location;
    const ignored = cache.get(file) ?? ignoredLines(root, file);
    cache.set(file, ignored);
    return !ignored.has(line);
  });
}
