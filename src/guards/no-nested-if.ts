import ts from "typescript";
import { location, type Finding } from "../model.ts";
import type { Project } from "../project.ts";

// A new function, method, constructor or accessor establishes its own control-flow scope.
// `else if` is also nesting: the second IfStatement is the first one's else branch.
export function noNestedIf(project: Project): Finding[] {
  const findings: Finding[] = [];

  for (const file of project.files) {
    const visit = (node: ts.Node, ifDepth: number): void => {
      if (ts.isFunctionLike(node)) {
        ts.forEachChild(node, child => visit(child, 0));
        return;
      }

      if (ts.isIfStatement(node) && ifDepth > 0) findings.push({
        guard: "no-nested-if",
        severity: "error",
        code: "CG001",
        message: "Nested if statement; use guard clauses or flatten the control flow.",
        location: location(project.root, node)
      });
      if (ts.isIfStatement(node)) {
        ts.forEachChild(node, child => visit(child, ifDepth + 1));
        return;
      }

      ts.forEachChild(node, child => visit(child, ifDepth));
    };

    visit(file, 0);
  }

  return findings;
}
