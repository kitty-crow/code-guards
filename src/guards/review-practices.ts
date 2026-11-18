import { withoutIgnored } from "../model.ts";
import ts from "typescript";
import { location, type Finding } from "../model.ts";
import type { Project } from "../project.ts";

/** Conservative AST checks for maintainability, regardless of how code was written. */
const testPath = /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|\.(?:test|spec)\.[cm]?tsx?$/;
type Hit = { code: string; node: ts.Node; title: string; reason: string; fix: string };
type RelatedHit = Hit & { related: ts.Node };
type Add = (item: Hit | RelatedHit) => void;
const titles: Readonly<Record<string, string>> = {
  CG319: "Comment narrates an obvious operation", CG320: "Unresolved method or imported API",
  CG321: "Inconsistent identifier convention", CG322: "Repeated statement sequence",
  CG323: "Catch block only rethrows its error", CG324: "Test assertion is tautological",
  CG325: "Stateless one-method class may be unnecessary", CG326: "Competing date-formatting patterns"
};

function emit(project: Project, item: Hit | RelatedHit): Finding {
  const source = item.node.getSourceFile();
  const line = item.node.getText(source).split("\n", 1)[0] ?? "";
  return {
    guard: "review-practices", severity: "warning", code: item.code,
    message: item.title, location: location(project.root, item.node),
    subject: line.slice(0, 110),
    span: Math.min(100, item.node.getWidth(source)),
    reason: item.reason, suggestion: item.fix,
    ...("related" in item ? { related: location(project.root, item.related) } : {})
  };
}

function walk(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, child => walk(child, inspect));
}

function comments(file: ts.SourceFile, node: ts.Node): string[] {
  const ranges = ts.getLeadingCommentRanges(file.text, node.getFullStart()) ?? [];
  return ranges.map(range => file.text.slice(range.pos, range.end).replace(/^\/\/|^\/\*|\*\/$/g, "").trim());
}

function narrated(node: ts.Node, file: ts.SourceFile, add: Add): void {
  const labels: [boolean, RegExp][] = [
    [ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node), /^(?:loop|iterate|go) (?:through|over|each)\b/i],
    [ts.isIfStatement(node), /^(?:check if|if the|verify whether)\b/i],
    [ts.isReturnStatement(node), /^(?:return|send back) (?:the |a |an )?/i],
    [ts.isVariableStatement(node), /^(?:declare|initialise|initialize|set|create) (?:the |a |an )?(?:variable|value|constant|array|list)\b/i],
    [ts.isExpressionStatement(node), /^(?:call|invoke|execute) (?:the |a |an )?(?:function|method|handler)\b/i]
  ];
  const description = comments(file, node).find(comment => labels.some(([matches, pattern]) => matches && pattern.test(comment))) ?? null;
  if (!description) return;
  add({code: "CG319", node, title: titles.CG319 ?? "Narrated comment", reason: `The preceding comment, "${description.slice(0, 110)}", restates the ${ts.SyntaxKind[node.kind]} operation rather than documenting its purpose.`, fix: "Remove the narration, or replace it with the non-obvious reason, invariant or trade-off that the code cannot express."});
}

function diagnosticIssues(project: Project, add: Add, includeTests: boolean): void {
  const relevant = new Set([2339, 2551, 2305, 2724, 2349, 2554]);
  for (const diagnostic of project.program.getSemanticDiagnostics()) {
    const file = diagnostic.file ?? null;
    const start = diagnostic.start ?? null;
    if (!file || !relevant.has(diagnostic.code) || start === null) continue;
    if (file.isDeclarationFile || !project.files.includes(file) || (!includeTests && testPath.test(file.fileName))) continue;
    const node = findNode(file, start);
    const detail = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    add({code: "CG320", node, title: titles.CG320 ?? "Unresolved API", reason: `TypeScript TS${diagnostic.code}: ${detail}`, fix: "Check the installed dependency version, available exports and method signatures. Use the supported API or correct the declaration; do not suppress the compiler diagnostic with an unsafe cast."});
  }
}

function findNode(file: ts.SourceFile, position: number): ts.Node {
  let located: ts.Node = file;
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(file) || position >= node.getEnd()) return;
    located = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return located;
}

function convention(file: ts.SourceFile, add: Add): void {
  const camel: ts.Identifier[] = [];
  const snake: ts.Identifier[] = [];
  for (const statement of file.statements) {
    const names: ts.Identifier[] = [];
    const identifier = ts.isFunctionDeclaration(statement) ? statement.name ?? null : null;
    if (identifier) names.push(identifier);
    if (ts.isVariableStatement(statement)) names.push(...statement.declarationList.declarations.map(part => part.name).filter(ts.isIdentifier));
    for (const name of names) {
      if (/^[a-z][a-z\d]*(?:[A-Z][a-z\d]*)+$/.test(name.text)) camel.push(name);
      if (/^[a-z][a-z\d]*(?:_[a-z\d]+)+$/.test(name.text)) snake.push(name);
    }
  }
  const majority = camel.length >= snake.length * 2 && camel.length >= 3 ? "camelCase" : snake.length >= camel.length * 2 && snake.length >= 3 ? "snake_case" : null;
  if (!majority) return;
  const outliers = majority === "camelCase" ? snake : camel;
  const filename = file.fileName.split(/[\\/]/).pop() ?? file.fileName;
  for (const name of outliers) add({code: "CG321", node: name, title: titles.CG321 ?? "Naming drift", reason: `${filename} contains ${camel.length} camelCase and ${snake.length} snake_case declarations. ${name.text} differs from the prevailing local style.`, fix: `Use ${majority} for local declarations unless this name mirrors a third-party schema, wire protocol or required public API.`});
}

function redundantCatch(node: ts.Node, add: Add): void {
  if (!ts.isTryStatement(node)) return;
  const clause = node.catchClause ?? null;
  if (!clause || clause.block.statements.length !== 1) return;
  const binding = clause.variableDeclaration ?? null;
  const only = clause.block.statements[0] ?? null;
  if (!binding || !ts.isIdentifier(binding.name) || !only || !ts.isThrowStatement(only)) return;
  const identifier = binding.name;
  const error = only.expression ?? null;
  if (!error || !ts.isIdentifier(error) || error.text !== identifier.text) return;
  add({code: "CG323", node: clause, title: titles.CG323 ?? "Rethrow-only catch", reason: `The catch handler immediately rethrows ${identifier.text} without recovery, context or cleanup. It adds no behaviour to the original exception.`, fix: "Remove the redundant catch. Keep a finally clause if cleanup is required, or add meaningful recovery or context when it is genuinely needed."});
}

function value(node: ts.Node | null): string | null {
  if (!node) return null;
  if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return `${node.kind}:${node.text}`;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return String(node.kind);
  return null;
}

function weakTest(node: ts.Node, add: Add): void {
  if (!ts.isCallExpression(node)) return;
  const callee = node.expression.getText();
  const first = node.arguments[0] ?? null;
  const actual = value(first);
  const truthy = (callee === "assert.ok" || callee === "assert") && first && first.kind === ts.SyntaxKind.TrueKeyword;
  const equal = /^(?:assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual))$/.test(callee) && actual !== null && actual === value(node.arguments[1] ?? null);
  const matcher = ts.isPropertyAccessExpression(node.expression) ? node.expression : null;
  const inner = matcher && ts.isCallExpression(matcher.expression) ? matcher.expression : null;
  const expectation = inner ? inner.expression.getText() : "";
  const expected = inner ? inner.arguments[0] ?? null : null;
  const asserted = value(expected);
  const method = matcher ? matcher.name.text : "";
  const sameValue = expectation === "expect" && asserted !== null && asserted === actual && /^(?:toBe|toEqual|toStrictEqual)$/.test(method);
  const obviousTruthy = expectation === "expect" && expected && expected.kind === ts.SyntaxKind.TrueKeyword && /^(?:toBeTruthy|toBeDefined)$/.test(method);
  if (!truthy && !equal && !sameValue && !obviousTruthy) return;
  add({code: "CG324", node, title: titles.CG324 ?? "Tautological test", reason: `The assertion ${node.getText().slice(0, 85)} compares known constants or tests an unconditional truth, so it cannot detect a regression in the implementation.`, fix: "Assert an actual function result, observable side effect or thrown error using meaningful inputs. Include a negative or boundary case where appropriate."});
}

function thinClass(node: ts.Node, add: Add): void {
  if (!ts.isClassDeclaration(node)) return;
  const name = node.name ?? null;
  if (!name || (node.heritageClauses ?? []).length) return;
  const methods = node.members.filter(ts.isMethodDeclaration);
  if (methods.length !== 1 || node.members.length !== 1) return;
  const method = methods[0] ?? null;
  const body = method ? method.body ?? null : null;
  if (!body || body.statements.length !== 1) return;
  const only = body.statements[0] ?? null;
  const result = only && ts.isReturnStatement(only) ? only.expression ?? null : null;
  if (!result) return;
  const hasState = /\b(?:this|super)\b/.test(result.getText());
  if (hasState) return;
  add({code: "CG325", node: name, title: titles.CG325 ?? "Unnecessary class shell", reason: `${name.text} contains one stateless method and no instance properties, constructor or inheritance. The class may add ceremony without modelling state or a useful contract.`, fix: `Consider a named exported function in place of ${name.text}. Keep the class if callers rely on construction, dependency injection or a documented extension boundary.`});
}

function dateFormats(file: ts.SourceFile, add: Add): void {
  const local: ts.Node[] = [];
  const intl: ts.Node[] = [];
  walk(file, node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "toLocaleDateString") local.push(node);
    if (ts.isNewExpression(node) && node.expression.getText(file) === "Intl.DateTimeFormat") intl.push(node);
  });
  if (!local.length || !intl.length) return;
  const item = local[0] ?? null;
  const other = intl[0] ?? null;
  if (!item || !other) return;
  add({code: "CG326", node: item, title: titles.CG326 ?? "Mixed date formatting", reason: "This module uses both toLocaleDateString and Intl.DateTimeFormat. Their locale, time zone and option defaults may diverge.", fix: "Consider sharing a formatter configured with explicit locale/time-zone options. Keep distinct formatters if they serve documented, different presentation requirements.", related: other});
}

type Segment = { owner: ts.Node; first: ts.Statement; signature: string };
function repeatedBlocks(project: Project, add: Add): void {
  const seen = new Map<string, Segment>();
  for (const file of project.files) {
    if (testPath.test(file.fileName)) continue;
    walk(file, node => {
      if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return;
      const body = node.body ?? null;
      if (!body || !ts.isBlock(body)) return;
      const statements = body.statements;
      if (statements.length < 4) return;
      for (let i = 0; i + 3 <= statements.length; i += 1) {
        const group = statements.slice(i, i + 3);
        const first = group[0] ?? null;
        if (!first) continue;
        const signature = group.map(stmt => stmt.getText().replace(/\s+/g, "")).join("|");
        if (signature.length < 85) continue;
        const earlier = seen.get(signature) ?? null;
        if (!earlier) { seen.set(signature, { owner: node, first, signature }); continue; }
        if (earlier.owner === node || earlier.owner.getSourceFile() === node.getSourceFile()) continue;
        const filename = earlier.first.getSourceFile().fileName.split(/[\\/]/).pop() ?? "";
        add({code: "CG322", node: first, title: titles.CG322 ?? "Repeated logic", reason: `Three consecutive statements repeat a sequence in ${filename}. Duplicated validation and transformations can drift independently.`, fix: "Check whether both paths require identical semantics. Extract a shared helper when they do; keep separate domain rules when the similarity is incidental.", related: earlier.first});
        break;
      }
    });
  }
}

export function reviewPractices(project: Project, includeTests = false): Finding[] {
  const results: Finding[] = [];
  const add: Add = hit => { results.push(emit(project, hit)); };
  diagnosticIssues(project, add, includeTests);
  repeatedBlocks(project, add);
  for (const file of project.files) {
    if (testPath.test(file.fileName) && !includeTests) {
      walk(file, node => weakTest(node, add));
      continue;
    }
    convention(file, add);
    dateFormats(file, add);
    walk(file, node => {
      narrated(node, file, add);
      redundantCatch(node, add);
      thinClass(node, add);
      if (testPath.test(file.fileName)) weakTest(node, add);
    });
  }
  return withoutIgnored(project.root, results);
}
