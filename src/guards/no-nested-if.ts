import ts from "typescript";
import { location, type Finding } from "../model.ts";
import type { Project } from "../project.ts";

function guidance(node: ts.IfStatement): string {
  if (ts.isIfStatement(node.parent) && node.parent.elseStatement === node) {
    return "Consider extracting a decision helper or restructuring mutually exclusive branches. Separate if statements are not automatically equivalent to else-if.";
  }
  const outer = node.parent && ts.isBlock(node.parent) && ts.isIfStatement(node.parent.parent)
    ? node.parent.parent : undefined;
  if (outer?.elseStatement) return "Consider extracting a named predicate or a small helper. An early return must preserve the outer else branch's behaviour.";
  if (outer) return "Consider a guard clause in the enclosing function: if (!condition) return; then handle the inner condition at the same level. In a loop, continue may be appropriate.";
  return "Consider a guard clause, a named predicate or a smaller function. Preserve branch exclusivity and control-flow behaviour.";
}

// Each function-like node is a fresh control-flow scope.
export function noNestedIf(project: Project): Finding[] {
  const findings: Finding[] = [];
  for (const file of project.files) {
    const visit = (node: ts.Node, depth: number): void => {
      if (ts.isFunctionLike(node)) { ts.forEachChild(node, child => visit(child, 0)); return; }
      if (ts.isIfStatement(node) && depth > 0) {
        findings.push({
          guard: "no-nested-if", severity: "warning", code: "CG001",
          message: `Nested if statement. ${guidance(node)}`,
          location: location(project.root, node)
        });
      }
      const next = ts.isIfStatement(node) ? depth + 1 : depth;
      ts.forEachChild(node, child => visit(child, next));
    };
    visit(file, 0);
  }
  return findings;
}
