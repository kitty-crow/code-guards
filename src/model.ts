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
export type Severity = "error" | "warning" | "info";
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

type Expectation = { location: Location; severity: Severity; subject: string };

// Expectations are resolved once after all selected guards have emitted their
// findings. Evaluating each guard separately would produce false missing reports.
function expectations(root: string, files: readonly ts.SourceFile[]): Map<string, Expectation> {
  const pending = new Map<string, Expectation>();
  for (const file of files) {
    const name = path.relative(root, file.fileName).split(path.sep).join("/");
    for (const [index, line] of file.text.split(/\r\n|\n|\r/).entries()) {
      const match = /^\s*\/\/@cg-expect-(error|warning)\s*$/.exec(line);
      if (!match) continue;
      const severity = (match[1] ?? "") === "error" ? "error" : "warning";
      pending.set(name + ":" + (index + 2), {
        location: {file: name, line: index + 1, column: line.indexOf("//") + 1},
        severity, subject: line.trim()
      });
    }
  }
  return pending;
}

function missing(item: Expectation): Finding {
  return {
    guard: "project-conventions", code: "CG327", severity: item.severity,
    message: "Expected Code Guards finding did not occur",
    location: item.location, subject: item.subject, span: item.subject.length,
    reason: "The next line produced no warning or error from the selected guards.",
    suggestion: "Remove the obsolete expectation or restore the intended checked contract."
  };
}

/** Resolve next-line expectations against the combined findings from the selected guards. */
export function resolveExpectations(root: string, files: readonly ts.SourceFile[], findings: Finding[]): Finding[] {
  const pending = expectations(root, files);
  const matched = new Set<string>();
  const remaining = findings.filter(item => {
    const key = item.location.file + ":" + item.location.line;
    if (!pending.has(key) || item.severity === "info") return true;
    matched.add(key);
    return false;
  });
  for (const [key, item] of pending) {
    if (!matched.has(key)) remaining.push(missing(item));
  }
  return remaining;
}

/** Errors fail every scan; warnings fail only strict scans. */
export function failed(findings: Finding[], strict: boolean): boolean {
  return findings.some(item => item.severity === "error" || (strict && item.severity === "warning"));
}
