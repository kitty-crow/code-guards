import path from "node:path";
import ts from "typescript";

export type Severity = "error" | "warning" | "info";
export type Location = { file: string; line: number; column: number };
export type Finding = {
  guard: "no-nested-if" | "type-reuse";
  severity: Severity;
  code: string;
  message: string;
  location: Location;
  related?: Location;
  similarity?: number;
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
