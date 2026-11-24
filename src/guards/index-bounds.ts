import ts from "typescript";

const typedArrays = new Set([
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Float16Array"
]);

function sameBinding(left: ts.Node, right: ts.Node, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right)) return false;
  const symbol = checker.getSymbolAtLocation(left) ?? null;
  return symbol !== null && symbol === (checker.getSymbolAtLocation(right) ?? null);
}

function denseLiteral(node: ts.ElementAccessExpression): boolean {
  const array = node.expression;
  const index = node.argumentExpression;
  if (!ts.isArrayLiteralExpression(array) || !ts.isNumericLiteral(index)) return false;
  const position = Number(index.text);
  return Number.isSafeInteger(position) && position >= 0 && position < array.elements.length &&
    array.elements.every(element => !ts.isOmittedExpression(element) && !ts.isSpreadElement(element));
}

function standardTypedArray(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const symbol = checker.getTypeAtLocation(node).getSymbol() ?? null;
  if (!symbol || !typedArrays.has(symbol.name)) return false;
  const declarations = symbol.declarations ?? [];
  return declarations.length > 0 && declarations.every(declaration => declaration.getSourceFile().hasNoDefaultLib);
}

function enclosingLoop(node: ts.Node): ts.ForStatement | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return null;
    if (ts.isForStatement(current)) return current;
  }
  return null;
}

function counterStartsAtZero(loop: ts.ForStatement, index: ts.Identifier, checker: ts.TypeChecker): boolean {
  const initial = loop.initializer ?? null;
  if (!initial || !ts.isVariableDeclarationList(initial) || !(initial.flags & ts.NodeFlags.Let)) return false;
  if (initial.declarations.length !== 1) return false;
  const declaration = initial.declarations[0] ?? null;
  if (!declaration || !sameBinding(declaration.name, index, checker)) return false;
  const value = declaration.initializer ?? null;
  return value !== null && ts.isNumericLiteral(value) && Number(value.text) === 0;
}

function counterBound(loop: ts.ForStatement, access: ts.ElementAccessExpression, checker: ts.TypeChecker): boolean {
  const condition = loop.condition ?? null;
  if (!condition || !ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return false;
  if (!sameBinding(condition.left, access.argumentExpression, checker)) return false;
  const limit = condition.right;
  return ts.isPropertyAccessExpression(limit) && limit.name.text === "length" &&
    sameBinding(limit.expression, access.expression, checker);
}

function incrementsOnce(loop: ts.ForStatement, index: ts.Identifier, checker: ts.TypeChecker): boolean {
  const step = loop.incrementor ?? null;
  if (!step || !(ts.isPrefixUnaryExpression(step) || ts.isPostfixUnaryExpression(step))) return false;
  return step.operator === ts.SyntaxKind.PlusPlusToken && sameBinding(step.operand, index, checker);
}

function changesBinding(node: ts.Node, access: ts.ElementAccessExpression, checker: ts.TypeChecker): boolean {
  const matches = (candidate: ts.Node): boolean =>
    sameBinding(candidate, access.argumentExpression, checker) || sameBinding(candidate, access.expression, checker);
  if (ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
    // Reject destructuring assignment as well, since it can modify the counter.
    return matches(node.left) || ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left);
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      matches(node.operand);
  }
  return false;
}

function stableBody(node: ts.Node, access: ts.ElementAccessExpression, checker: ts.TypeChecker): boolean {
  // Calls, suspension, constructors and nested functions could change the
  // receiver or its underlying buffer through an alias.
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) || ts.isFunctionLike(node) || ts.isTaggedTemplateExpression(node) ||
      ts.isForInStatement(node) || ts.isForOfStatement(node)) return false;
  if (changesBinding(node, access, checker)) return false;
  return !ts.forEachChild(node, child => stableBody(child, access, checker) ? null : true);
}

/** Prove dense literal reads and a restricted, stable typed-array iteration. */
export function provenIndex(node: ts.ElementAccessExpression, checker: ts.TypeChecker): boolean {
  if (denseLiteral(node)) return true;
  const index = node.argumentExpression;
  if (!ts.isIdentifier(index) || !ts.isIdentifier(node.expression) || !standardTypedArray(node.expression, checker)) return false;
  const loop = enclosingLoop(node);
  if (!loop || node.getStart() < loop.statement.getStart() || node.getEnd() > loop.statement.getEnd()) return false;
  return counterStartsAtZero(loop, index, checker) && counterBound(loop, node, checker) &&
    incrementsOnce(loop, index, checker) && stableBody(loop.statement, node, checker);
}
