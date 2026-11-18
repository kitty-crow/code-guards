import { withoutIgnored } from "../model.ts";
import ts from "typescript";
import { location, type Finding } from "../model.ts";
import type { Project } from "../project.ts";

function outerIf(node: ts.IfStatement): ts.IfStatement | null {
  if (ts.isIfStatement(node.parent)) return node.parent;
  const parent = node.parent;
  return ts.isBlock(parent) && ts.isIfStatement(parent.parent) ? parent.parent : null;
}

function terminalStatement(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement) && statement.statements.length === 1) {
    const only = statement.statements[0] ?? null;
    return Boolean(only && (ts.isReturnStatement(only) || ts.isThrowStatement(only)));
  }
  return false;
}

function fallbackReturn(outer: ts.IfStatement): ts.ReturnStatement | null {
  const parent = outer.parent;
  if (!ts.isBlock(parent)) return null;
  const index = parent.statements.indexOf(outer);
  const next = parent.statements[index + 1] ?? null;
  return next && ts.isReturnStatement(next) ? next : null;
}

function negated(expression: ts.Expression): string {
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) return expression.operand.getText();
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) return `!${expression.getText()}`;
  return `!(${expression.getText()})`;
}

// Lifting a nested condition is safe only when the outer branch terminates or
// the original fallback is preserved. Otherwise recommend review, not a rewrite.
function suggestion(node: ts.IfStatement, outer: ts.IfStatement | null): string {
  const expression = node.expression.getText();
  const before = outer ? outer.expression.getText() : "the enclosing condition";
  const isElseIf = outer !== null && (outer.elseStatement ?? null) === node;
  if (isElseIf && outer && terminalStatement(outer.thenStatement)) {
    return `The preceding 'if (${before})' branch always returns or throws, so the 'else' is redundant. Replace that clause with:
  ${node.getText()}
Keep the final fallback unchanged.`;
  }
  if (isElseIf) {
    return `The branch 'if (${expression})' is only checked when 'if (${before})' is false. Extract this decision into a named helper or simplify the branches without making them independent.`;
  }
  if (outer && (outer.elseStatement ?? null)) {
    return `The outer 'if (${before})' has an else branch. Extract a helper or combine conditions only after verifying that the else branch remains reachable in exactly the same cases.`;
  }
  const onlyInner = outer && ts.isBlock(outer.thenStatement) && outer.thenStatement.statements.length === 1 && (outer.thenStatement.statements[0] ?? null) === node;
  const fallback = outer && onlyInner ? fallbackReturn(outer) : null;
  const fallbackExpression = fallback ? (fallback.expression ?? null) : null;
  if (outer && fallbackExpression) {
    return `Replace the outer block with an early return and the lifted inner clause:
  if (${negated(outer.expression)}) return ${fallbackExpression.getText()};
  ${node.getText()}
Keep the existing final return after these statements.`;
  }
  if (outer) {
    return `Consider an early exit for '!(${before})', then move 'if (${expression})' one level out. Use 'return' only if ending this function is correct; use 'continue' inside a loop when appropriate.`;
  }
  return `Extract a named predicate or a smaller function for 'if (${expression})'; do not change which branches run or when they return.`;
}

// A function-like declaration starts a new control-flow scope. Else-if remains nesting.
export function noNestedIf(project: Project): Finding[] {
  const findings: Finding[] = [];
  for (const file of project.files) {
    const visit = (node: ts.Node, depth: number): void => {
      if (ts.isFunctionLike(node)) { ts.forEachChild(node, child => visit(child, 0)); return; }
      if (ts.isIfStatement(node) && depth > 0) {
        const outer = outerIf(node);
        const current = `if (${node.expression.getText(file)})`;
        const enclosing = outer ? `if (${outer.expression.getText(file)})` : "an enclosing if";
        const isElseIf = outer !== null && (outer.elseStatement ?? null) === node;
        findings.push({
          guard: "no-nested-if", severity: "warning", code: "CG001",
          message: isElseIf ? "Else-if chain introduces another conditional level" : "Nested conditional increases control-flow depth",
          location: location(project.root, node),
          subject: current,
          span: node.expression.getEnd() - node.getStart(file) + 1,
          reason: isElseIf
            ? `The '${current}' clause is attached to '${enclosing}' via 'else'. These branches are mutually exclusive.`
            : `The '${current}' clause is inside '${enclosing}', so both conditions must hold to reach its body.`,
          suggestion: suggestion(node, outer)
        });
      }
      const next = ts.isIfStatement(node) ? depth + 1 : depth;
      ts.forEachChild(node, child => visit(child, next));
    };
    visit(file, 0);
  }
  return withoutIgnored(project.root, findings);
}
