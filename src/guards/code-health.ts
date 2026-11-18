import ts from "typescript";
import { location, type Finding } from "../model.ts";
import type { EmitIssue } from "./issue.ts";
import type { Project } from "../project.ts";
import { deterministicTypes } from "./types.ts";

// High-confidence compiler-backed candidates. They are warnings, never automatic edits.
type Report = EmitIssue;
const testPath = /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|\.(?:test|spec)\.[cm]?tsx?$/;
const isBooleanLiteral = (node: ts.Expression, value: boolean): boolean => node.kind === (value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword);
function bodyOf(node: ts.Node): ts.ConciseBody | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node)) return node.body ?? null;
  return null;
}

function visitAll(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => visitAll(child, visit));
}

function testFiles(project: Project): ts.SourceFile[] {
  return project.files.filter(file => testPath.test(file.fileName));
}

function isWritten(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isBinaryExpression(parent) && parent.left === identifier) return parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  return false;
}

function readCalls(node: ts.Node, calls: Set<string>): void {
  if (ts.isCallExpression(node)) calls.add(node.expression.getText());
  ts.forEachChild(node, child => readCalls(child, calls));
}

// A method with no apparent instance-state dependency can still be a required
// public API boundary, so design findings must advise review, not removal.
function inspectFunction(node: ts.Node, project: Project, report: Report): void {
  const body = bodyOf(node);
  if (!body) return;
  const fn = node as ts.FunctionLikeDeclaration;
  const named = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
  const fnName = named ? node.name ?? null : null;
  const name = fnName ? fnName.getText() : named ? "anonymous" : "function";
  const parameters = fn.parameters;
  const booleans = parameters.filter(parameter => project.checker.getTypeAtLocation(parameter).flags & ts.TypeFlags.BooleanLike);
  const optional = parameters.filter(parameter => Boolean((parameter.questionToken ?? null) || (parameter.initializer ?? null)));
  if (parameters.length >= 7 || booleans.length >= 3 || (parameters.length >= 5 && optional.length >= 3)) {
    report({guard: "function-contracts", code: "CG312", node: node, message: "Function contract has too many switches or arguments", reason: `${name} accepts ${parameters.length} parameters, including ${booleans.length} booleans and ${optional.length} optional/defaulted values. Positional calls may be difficult to interpret.`, suggestion: "Consider a named options object, distinct intent-specific entry points, or a smaller function. Preserve existing call contracts while migrating."});
  }
  if (fnName && ts.isIdentifier(fnName) && /^(?:doStuff|handleThing|processData|foo|bar|util|helper|manager|temp|fn)$/i.test(fnName.text)) {
    report({guard: "naming", code: "CG310", node: fnName, message: "Uninformative function name", reason: `The name ${fnName.text} does not state the operation or the entity it affects.`, suggestion: `Rename ${fnName.text} to a verb and domain noun reflecting its observable behaviour, then update call sites.`});
  }
  if (ts.isBlock(body) && body.statements.length <= 2 && /(?:TODO|FIXME|not implemented|implement later|placeholder)/i.test(body.getText())) {
    report({guard: "incomplete-implementation", code: "CG315", node, message: "Implementation appears unfinished", reason: `${name} contains a placeholder marker in its executable body.`, suggestion: "Implement the missing behaviour or throw a documented unsupported-operation error; add a test that exercises the result."});
  }
  const calls = new Set<string>();
  if (ts.isMethodDeclaration(node)) readCalls(body, calls);
  if (ts.isMethodDeclaration(node) && !/\b(?:this|super)\b/.test(body.getText()) && body.getText().split("\n").length >= 14 && calls.size >= 2) {
    report({guard: "responsibility", code: "CG307", node, message: "Method may not belong to this class", reason: `${name} spans ${body.getText().split("\n").length} lines, calls ${[...calls].slice(0, 5).join(", ")}, and never accesses this or super.`, suggestion: "Review whether a focused collaborator/module should own this operation. Keep it as a method if the class boundary is intentional."});
  }
  const only = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] ?? null : null;
  const returned = only && ts.isReturnStatement(only) ? only.expression ?? null : null;
  if (returned && ts.isCallExpression(returned) && ts.isMethodDeclaration(node) && !/\bthis\b/.test(body.getText())) {
    report({guard: "overengineering", code: "CG308", node: node, message: "Method is only a forwarding wrapper", reason: `${name} immediately returns another function's result and does not access instance state.`, suggestion: "Consider using the called function directly or exporting a small helper. Keep the wrapper if it enforces a useful public API boundary."});
  }
}

function checkIf(stmt: ts.IfStatement, report: Report): void {
  const yes = stmt.thenStatement;
  const no = stmt.elseStatement ?? null;
  if (!no || !ts.isBlock(yes) || !ts.isBlock(no)) return;
  if (yes.statements.length !== 1 || no.statements.length !== 1) return;
  const first = yes.statements[0] ?? null;
  const second = no.statements[0] ?? null;
  if (!first || !second || !ts.isReturnStatement(first) || !ts.isReturnStatement(second)) return;
  const positive = first.expression ?? null;
  const negative = second.expression ?? null;
  if (!positive || !negative || !isBooleanLiteral(positive, true) || !isBooleanLiteral(negative, false)) return;
  const conditionType = stmt.expression.getText();
  report({guard: "simplify-code", code: "CG302", node: stmt, message: "Conditional returns its own boolean test", reason: `The true branch returns true and the false branch returns false, duplicating the test ${conditionType}.`, suggestion: `If ${conditionType} has a boolean type, replace this whole conditional with return ${conditionType};. Check narrowing and side effects first.`});
}

const registrationNames = new Set(["test", "it", "describe", "suite"]);
const registrationModifiers = new Set(["only", "skip", "todo", "concurrent"]);

function registrationImport(declaration: ts.Declaration, members: readonly string[]): ts.ImportDeclaration | null {
  if (ts.isImportSpecifier(declaration) &&
      registrationNames.has((declaration.propertyName ?? declaration.name).text) &&
      members.every(member => registrationModifiers.has(member))) {
    const source = declaration.parent.parent.parent;
    return ts.isImportDeclaration(source) ? source : null;
  }
  if (ts.isImportClause(declaration) && members.every(member => registrationModifiers.has(member))) {
    const source = declaration.parent;
    return ts.isImportDeclaration(source) ? source : null;
  }
  if (ts.isNamespaceImport(declaration) &&
      registrationNames.has(members[0] ?? "") &&
      members.slice(1).every(member => registrationModifiers.has(member))) {
    const source = declaration.parent.parent;
    return ts.isImportDeclaration(source) ? source : null;
  }
  return null;
}

/**
 * Test-runner registration Promises are handled by the runner itself.
 * Resolve the imported binding so an unrelated local test() or a shadowed
 * identifier still receives the normal unhandled-Promise warning.
 */
function isRunnerRegistration(call: ts.CallExpression, project: Project): boolean {
  const members: string[] = [];
  let callee: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(callee)) {
    members.unshift(callee.name.text);
    callee = callee.expression;
  }
  if (!ts.isIdentifier(callee)) return false;
  const symbol = project.checker.getSymbolAtLocation(callee) ?? null;
  const declarations = symbol ? symbol.declarations ?? [] : [];
  for (const declaration of declarations) {
    const source = registrationImport(declaration, members);
    if (!source || !ts.isStringLiteral(source.moduleSpecifier)) continue;
    if (source.moduleSpecifier.text === "node:test" || source.moduleSpecifier.text === "bun:test") return true;
  }
  return false;
}

function checkAsync(node: ts.Node, project: Project, report: Report): void {
  if (ts.isCatchClause(node) && ts.isBlock(node.block) && node.block.statements.length === 0) {
    report({guard: "async-safety", code: "CG303", node: node, message: "Caught error is silently discarded", reason: "This empty catch clause hides the failure and makes diagnosis difficult.", suggestion: "Handle the error, propagate it or document an intentional best-effort failure with a specific justification."});
  }
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return;
  const callee = node.expression.expression;
  if (ts.isPropertyAccessExpression(callee) && ["catch", "then"].includes(callee.name.text)) return;
  if (isRunnerRegistration(node.expression, project)) return;
  const type = project.checker.getTypeAtLocation(node.expression);
  const symbol = type.symbol ?? null;
  if (!/^Promise(?:Like)?</.test(project.checker.typeToString(type)) && !(symbol && symbol.getName() === "Promise")) return;
  report({guard: "async-safety", code: "CG303", node: node.expression, message: "Promise result is ignored", reason: `The expression ${node.expression.getText().slice(0, 65)} returns a Promise but is neither awaited nor explicitly handled.`, suggestion: "Await the call, return its Promise, or attach an error handler. For intentionally detached work, use an explicit void expression with a documented failure policy."});
}

function checkAssertions(node: ts.Node, report: Report): void {
  if (ts.isNonNullExpression(node)) {
    report({guard: "type-assertions", code: "CG305", node: node, message: "Non-null assertion bypasses a type check", reason: `The expression ${node.getText().slice(0, 70)} asserts away possible null or undefined.`, suggestion: "Check the value with a guard clause or use a type-safe API that guarantees its presence."});
  }
}

function checkSwitch(node: ts.Node, project: Project, report: Report): void {
  if (!ts.isSwitchStatement(node)) return;
  if (node.caseBlock.clauses.some(ts.isDefaultClause)) return;
  const type = project.checker.getTypeAtLocation(node.expression);
  if (!type.isUnion() || type.types.length > 30) return;
  const possibilities = type.types.filter(item => item.isStringLiteral()).map(item => item.isStringLiteral() ? item.value : "");
  if (!possibilities.length || possibilities.length !== type.types.length) return;
  const handled = new Set(node.caseBlock.clauses.filter(ts.isCaseClause).map(item => ts.isStringLiteral(item.expression) ? item.expression.text : ""));
  const missing = possibilities.filter(item => !handled.has(item));
  if (!missing.length) return;
  report({guard: "state-exhaustiveness", code: "CG306", node: node, message: "Switch misses union states", reason: `The discriminated union contains cases ${missing.map(x => JSON.stringify(x)).join(", ")} not handled by this switch.`, suggestion: `Handle ${missing.map(x => `case ${JSON.stringify(x)}:`).join(" ")} or use an exhaustive never check. Do not silently fall through.`});
}

function checkVariable(node: ts.Node, project: Project, report: Report, writes: Map<ts.Symbol, number>): void {
  if (!ts.isVariableDeclarationList(node) || !(node.flags & ts.NodeFlags.Let)) return;
  for (const item of node.declarations) {
    if (!(item.initializer ?? null) || !ts.isIdentifier(item.name)) continue;
    const symbol = project.checker.getSymbolAtLocation(item.name) ?? null;
    if (!symbol || (writes.get(symbol) ?? 0) > 0) continue;
    report({guard: "derived-state", code: "CG313", node: item.name, message: "Mutable binding is never reassigned", reason: `${item.name.text} is declared with let but the project contains no assignments or updates to this binding.`, suggestion: `Use const ${item.name.text} instead. If it represents derived data, calculate it from the source value rather than maintaining redundant state.`});
  }
}

function checkTest(node: ts.Node, report: Report): void {
  if (!ts.isCallExpression(node)) return;
  const name = node.expression.getText();
  if (!/^(?:test|it|describe)(?:\.|$)/.test(name)) return;
  const callback = node.arguments.find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) ?? null;
  if (!callback) return;
  const text = callback.getText();
  const hasAssert = /\b(?:assert|expect|should|throws|rejects|spyOn|verify)\s*(?:\.|\()/.test(text);
  if (hasAssert) return;
  if (name === "describe") return;
  report({guard: "test-quality", code: "CG314", node: node, message: "Test has no meaningful assertion", reason: `This ${name} callback contains no recognisable assertion or failure expectation.`, suggestion: "Assert a concrete result or side effect; avoid tests that only invoke functions and always pass."});
}

function inspectDeadCode(node: ts.Node, report: Report): void {
  if (!ts.isBlock(node)) return;
  const statements = node.statements;
  for (let i = 1; i < statements.length; i += 1) {
    const prior = statements[i - 1] ?? null;
    const current = statements[i] ?? null;
    if (!prior || !current || !(ts.isReturnStatement(prior) || ts.isThrowStatement(prior) || ts.isBreakStatement(prior) || ts.isContinueStatement(prior))) continue;
    report({guard: "dead-code", code: "CG301", node: current, message: "Unreachable statement after unconditional exit", reason: `The preceding ${ts.SyntaxKind[prior.kind]} exits this block before this statement can execute.`, suggestion: "Remove the unreachable code or move it before the exit if it is required."});
  }
}

function inspectImports(file: ts.SourceFile, report: Report): void {
  const imported = file.statements.filter(ts.isImportDeclaration).filter(item => ts.isStringLiteral(item.moduleSpecifier) && item.moduleSpecifier.text.startsWith("."));
  const modules = new Set(imported.map(item => (item.moduleSpecifier as ts.StringLiteral).text));
  if (modules.size < 10) return;
  const current = imported[0] ?? null;
  if (!current) return;
  report({guard: "coupling", code: "CG311", node: current, message: "Module has excessive direct dependencies", reason: `This module imports from ${modules.size} distinct local modules, increasing change coupling.`, suggestion: "Consider extracting cohesive responsibilities behind smaller module interfaces or a shared facade."});
}

function collectWrites(project: Project): Map<ts.Symbol, number> {
  const writes = new Map<ts.Symbol, number>();
  for (const file of project.files) visitAll(file, node => {
    if (!ts.isIdentifier(node) || !isWritten(node)) return;
    const symbol = project.checker.getSymbolAtLocation(node) ?? null;
    if (!symbol) return;
    writes.set(symbol, (writes.get(symbol) ?? 0) + 1);
  });
  return writes;
}

export function codeHealth(project: Project, includeTests = false): Finding[] {
  const findings: Finding[] = [];
  const writes = collectWrites(project);
  const report: Report = item => {
    const {guard, code, node, message, reason, suggestion} = item;
    const source = node.getSourceFile();
    const line = node.getText(source).split("\n", 1)[0] ?? "";
    findings.push({ guard, code, severity: "warning", message, location: location(project.root, node), subject: line.slice(0, 120), span: Math.min(100, node.getWidth(source)), reason, suggestion, ...("related" in item ? {related: location(project.root, item.related)} : {}) });
  };
  for (const file of project.files) {
    const isTest = testPath.test(file.fileName);
    if (isTest && !includeTests) continue;
    inspectImports(file, report);
    visitAll(file, node => {
      inspectDeadCode(node, report);
      if (ts.isIfStatement(node)) checkIf(node, report);
      checkAsync(node, project, report);
      checkAssertions(node, report);
      checkSwitch(node, project, report);
      checkVariable(node, project, report, writes);
      inspectFunction(node, project, report);
      if (isTest) checkTest(node, report);
    });
  }
  deterministicTypes(project, includeTests, report);
  // Test quality remains enabled for tests even if general code-quality excludes tests.
  if (!includeTests) for (const file of testFiles(project)) visitAll(file, node => checkTest(node, report));
  return findings;
}
