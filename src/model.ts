import path from "node:path";
import ts from "typescript";

export const guards = ["no-nested-if", "type-reuse", "function-quality"] as const;
export type GuardName = typeof guards[number];
export type Severity = "warning" | "info";
export type Location = { file: string; line: number; column: number };
export type Finding = {
  guard: GuardName;
  severity: Severity;
  code: string;
  message: string;
  location: Location;
  related?: Location;
  relatedSpan?: number;
  similarity?: number;
  subject?: string;
  span?: number;
  reason?: string;
  suggestion?: string;
};

export function location(root: string, node: ts.Node): Location {
  const file = node.getSourceFile();
  const position = file.getLineAndCharacterOfPosition(node.getStart(file));
  return {
    file: path.relative(root, file.fileName).split(path.sep).join("/"),
    line: position.line + 1,
    column: position.character + 1
  };
}
