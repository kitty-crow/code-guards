import ts from "typescript";
import { isTestFile, type Project } from "../project.ts";
import type { EmitIssue } from "./issue.ts";
import { provenIndex } from "./index-bounds.ts";

const forbidden = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined;

function argumentsOf(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  if (type.isUnionOrIntersection()) return type.types;
  if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
    return checker.getTypeArguments(type as ts.TypeReference);
  }
  return type.aliasTypeArguments ?? [];
}

function looseFlags(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>()): number {
  if (seen.has(type)) return 0;
  seen.add(type);
  return argumentsOf(type, checker).reduce((flags, item) => flags | looseFlags(item, checker, seen), type.flags & forbidden);
}

function optional(node: ts.Node): boolean {
  if (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) ||
      ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isNamedTupleMember(node)) {
    return Boolean(node.questionToken ?? null);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) {
    return Boolean(node.questionDotToken ?? null);
  }
  return ts.isOptionalTypeNode(node);
}

function asserted(node: ts.Node): boolean {
  return (ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && Boolean(node.exclamationToken ?? null);
}

function valueSite(node: ts.Node): boolean {
  return ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node) ||
    ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) || ts.isCallExpression(node) || ts.isNewExpression(node) ||
    ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isAwaitExpression(node) ||
    ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isConditionalExpression(node) ||
    ts.isBinaryExpression(node) || ts.isArrayLiteralExpression(node) || ts.isTypeReferenceNode(node) ||
    ts.isIndexedAccessTypeNode(node) || ts.isTypeQueryNode(node) ||
    (ts.isIdentifier(node) && node.text === "undefined");
}

function resultType(node: ts.SignatureDeclaration, checker: ts.TypeChecker): string {
  const signature = checker.getSignatureFromDeclaration(node) ?? null;
  if (!signature) return "";
  const result = checker.getReturnTypeOfSignature(signature);
  return looseFlags(result, checker) ? "Return type is not deterministic: " + checker.typeToString(result) : "";
}

// An unchecked API result may be normalised directly, without letting an
// undefined value enter a declaration, argument or return contract.
function normalised(node: ts.Node, type: ts.Type, checker: ts.TypeChecker, flags: number): boolean {
  if (flags !== ts.TypeFlags.Undefined) return false;
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && parent.left === node) {
    return looseFlags(checker.getTypeAtLocation(parent), checker) === 0;
  }
  if (!ts.isExpressionStatement(parent)) return false;
  const members = type.isUnion() ? type.types : [type];
  if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) {
    return members.some(member => Boolean(member.flags & ts.TypeFlags.Undefined));
  }
  return members.every(member => Boolean(member.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)));
}

function writeTarget(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isDeleteExpression(parent)) return parent.expression === node;
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node;
}

function readsCaughtValue(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(node)) return false;
  const symbol = checker.getSymbolAtLocation(node) ?? null;
  const declaration = symbol ? symbol.valueDeclaration ?? null : null;
  if (!declaration || !ts.isVariableDeclaration(declaration) ||
      !ts.isCatchClause(declaration.parent) || declaration.name === node) return false;
  const parent = node.parent;
  if (ts.isTypeOfExpression(parent)) return false;
  if (!ts.isBinaryExpression(parent)) return true;
  const operator = parent.operatorToken.kind;
  if (operator === ts.SyntaxKind.InstanceOfKeyword && parent.left === node) return false;
  const other = parent.left === node ? parent.right : parent.left;
  const equality = operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken ||
    operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  return !equality || other.kind !== ts.SyntaxKind.NullKeyword;
}

function describe(node: ts.Node, checker: ts.TypeChecker): string {
  switch (node.kind) {
    case ts.SyntaxKind.AnyKeyword: return "Explicit any type";
    case ts.SyntaxKind.UnknownKeyword: return "Explicit unknown type";
    case ts.SyntaxKind.UndefinedKeyword: return "Explicit undefined type";
    case ts.SyntaxKind.VoidExpression: return "Expression produces undefined";
  }
  if (optional(node)) return "Optional declaration or chain permits undefined";
  if (asserted(node)) return "Definite-assignment assertion bypasses initialisation checking";
  if (ts.isFunctionLike(node)) return resultType(node, checker);
  // JavaScript supplies the catch binding. Check reads of it after control-flow
  // narrowing, while explicit type annotations still go through the syntax rules.
  if (ts.isVariableDeclaration(node) && ts.isCatchClause(node.parent)) return "";
  if (!valueSite(node) && !readsCaughtValue(node, checker)) return "";
  if (ts.isTypeReferenceNode(node) && node.typeName.getText() === "const") return "";
  if (writeTarget(node)) return "";
  if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name) && !(node.type ?? null)) return "";
  const type = checker.getTypeAtLocation(node);
  const flags = looseFlags(type, checker);
  if (ts.isIdentifier(node) && node.text === "undefined" && flags) return "Explicit undefined value";
  if (!flags || normalised(node, type, checker, flags)) return "";
  if (flags === ts.TypeFlags.Undefined && ts.isElementAccessExpression(node) && provenIndex(node, checker)) return "";
  return "Value or type is not deterministic: " + checker.typeToString(type);
}

// A receiving declaration repeats an inferred diagnostic when its initialiser
// already identifies the same loose type. Keep explicit contracts and separate
// unchecked index operations; they require independent corrections.
function origin(node: ts.Node): ts.Node | null {
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) ||
      ts.isParameter(node) || ts.isPropertyAssignment(node)) return node.initializer ?? null;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return node.expression;
  return null;
}

function repeatedInference(node: ts.Node, checker: ts.TypeChecker, message: string): boolean {
  if (!message.startsWith("Value or type is not deterministic:")) return false;
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) &&
      (node.type ?? null)) return false;
  const child = origin(node);
  if (!child) return false;
  const flags = looseFlags(checker.getTypeAtLocation(node), checker);
  if (flags !== looseFlags(checker.getTypeAtLocation(child), checker)) return false;
  if ((ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) &&
      flags === ts.TypeFlags.Undefined) return false;
  if (flags === ts.TypeFlags.Undefined && ts.isElementAccessExpression(child) && provenIndex(child, checker)) return true;
  return describe(child, checker).startsWith("Value or type is not deterministic:");
}

function checkTree(node: ts.Node, checker: ts.TypeChecker, report: EmitIssue): void {
  const message = describe(node, checker);
  if (message && !repeatedInference(node, checker, message)) report({
    guard: "type-assertions", code: "CG305", node, message,
    reason: "Any, unknown and undefined leave the value without a fully specified type or presence contract.",
    suggestion: "Use a concrete type, checked access, an explicit null alternative or a discriminated union. Validate external data at its boundary without asserting away its type."
  });
  ts.forEachChild(node, child => checkTree(child, checker, report));
}

/** Check type contracts with strict null and indexed-access analysis, without changing the target configuration. */
export function deterministicTypes(project: Project, includeTests: boolean, report: EmitIssue): void {
  const options = project.program.getCompilerOptions();
  const program = ts.createProgram({
    rootNames: project.program.getRootFileNames(),
    options: { ...options, strictNullChecks: true, noUncheckedIndexedAccess: true, noImplicitAny: true, useUnknownInCatchVariables: true }
  });
  const checker = program.getTypeChecker();
  for (const file of project.files) {
    if (!includeTests && isTestFile(file.fileName)) continue;
    const source = program.getSourceFile(file.fileName) ?? null;
    if (source) checkTree(source, checker, report);
  }
}
