import ts from "typescript";
import { location, type Finding } from "../model.ts";
import type { Project } from "../project.ts";
import { supportsReuse, zeroShot, type SemanticScorer } from "../semantic.ts";

type FunctionInfo = {
  name: string;
  node: ts.Node;
  body: ts.Block | ts.ConciseBody;
  lines: number;
  branches: number;
  statements: number;
  dependencies: Set<string>;
  calls: Set<string>;
  comments: boolean;
  arguments: number;
  fingerprint: string;
};

function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.name?.getText();
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const expression = ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  if (expression && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (expression && ts.isPropertyAssignment(node.parent)) return node.parent.name.getText();
  return undefined;
}

function recordCall(project: Project, file: ts.SourceFile, node: ts.CallExpression, info: FunctionInfo): void {
  const target = node.expression;
  info.calls.add(target.getText(file));
  const symbol = project.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(target) ? target.name : target);
  const source = symbol?.declarations?.[0]?.getSourceFile();
  if (source && source !== file && !source.isDeclarationFile) info.dependencies.add(source.fileName);
}

function getInfo(project: Project, includeTests: boolean): FunctionInfo[] {
  const result: FunctionInfo[] = [];
  for (const file of project.files) {
    if (!includeTests && /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|\.(?:test|spec)\.[cm]?tsx?$/.test(file.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (!ts.isFunctionLike(node)) { ts.forEachChild(node, visit); return; }
      const name = functionName(node);
      const body = "body" in node ? node.body : undefined;
      if (!name || !body) { ts.forEachChild(node, visit); return; }
      const info: FunctionInfo = {
        name, node, body, lines: 0, branches: 0, statements: 0,
        dependencies: new Set(), calls: new Set(), comments: false, arguments: node.parameters.length, fingerprint: ""
      };
      const start = file.getLineAndCharacterOfPosition(body.getStart(file)).line;
      const end = file.getLineAndCharacterOfPosition(body.getEnd()).line;
      info.lines = end - start + 1;
      const text = body.getText(file);
      info.comments = /\/\/|\/\*/.test(text) || (ts.getLeadingCommentRanges(file.text, node.getFullStart())?.length ?? 0) > 0;
      const visitBody = (current: ts.Node): void => {
        if (current !== body && ts.isFunctionLike(current)) return;
        if (ts.isStatement(current) && current !== body) info.statements += 1;
        if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isForStatement(current) || ts.isForOfStatement(current) || ts.isForInStatement(current) || ts.isWhileStatement(current) || ts.isCaseClause(current) || ts.isCatchClause(current)) info.branches += 1;
        if (ts.isCallExpression(current)) recordCall(project, file, current, info);
        ts.forEachChild(current, visitBody);
      };
      visitBody(body);
      info.fingerprint = body.getText(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/\s+/g, "").replace(/\b[a-z_$][\w$]*(?=\s*\()/gi, "_");
      result.push(info);
      ts.forEachChild(node, child => { if (child !== body) visit(child); });
    };
    visit(file);
  }
  return result;
}

function evidence(info: FunctionInfo): string {
  return `The TypeScript function ${info.name} is ${info.lines} lines long, contains ${info.branches} decision branches, ${info.statements} statements, takes ${info.arguments} arguments, and calls ${[...info.calls].slice(0, 12).join(", ") || "nothing"}. It uses ${info.dependencies.size} external source modules. ${info.comments ? "It contains comments." : "It has no explanatory comments."}`;
}

type Emit = (info: FunctionInfo, code: string, message: string, similarity?: number, related?: FunctionInfo) => void;

async function reviewFunction(info: FunctionInfo, score: SemanticScorer, emit: Emit): Promise<void> {
  const checks = [
    { trigger: info.lines >= 45 && info.branches >= 4, code: "CG201", suggestion: "this function has multiple responsibilities and should be split into smaller focused functions", opposite: "this function is cohesive and should remain one function", note: "Consider separating responsibilities into smaller functions." },
    { trigger: info.lines >= 25 && info.branches >= 3 && !info.comments, code: "CG202", suggestion: "this function needs explanatory comments describing non-obvious decisions and invariants", opposite: "this function is self-explanatory and needs no comments", note: "Consider documenting the non-obvious decisions or invariants, not narrating each statement." },
    { trigger: info.dependencies.size >= 4, code: "CG203", suggestion: "this function depends on too many external modules and may belong in a different module", opposite: "the function has appropriate modular dependencies", note: "Review module ownership and reduce unnecessary coupling." },
    { trigger: ts.isMethodDeclaration(info.node) && info.lines <= 6 && info.statements <= 2 && !/\b(?:this|super)\b/.test(info.body.getText()), code: "CG204", suggestion: "this short stateless method could be a standalone helper or arrow function instead of a class method", opposite: "this method belongs to the class and needs its own method declaration", note: "Consider a small reusable helper or arrow function if it adds clarity." }
  ];
  for (const check of checks) {
    if (!check.trigger) continue;
    const verdict = await score({ premise: evidence(info), same: check.suggestion, different: check.opposite });
    if (supportsReuse(verdict, 0.75)) emit(info, check.code, `${check.note} Evidence: ${info.lines} lines, ${info.branches} branches, ${info.dependencies.size} external modules.`, verdict.sameConcept);
  }
}

async function reviewSimilarFunctions(functions: FunctionInfo[], score: SemanticScorer, emit: Emit): Promise<void> {
  // Exact duplicates are deterministic. Near-duplicates are sent to MNLI only
  // after statement count and overlapping call-site checks narrow the pairs.
  for (let i = 0; i < functions.length; i += 1) {
    const left = functions[i];
    if (!left || left.statements < 3) continue;
    for (let j = i + 1; j < functions.length; j += 1) {
      const right = functions[j];
      if (!right || right.statements < 3 || right.node.getSourceFile() === left.node.getSourceFile()) continue;
      if (Math.abs(left.statements - right.statements) > 2 || Math.abs(left.arguments - right.arguments) > 1) continue;
      if (left.fingerprint === right.fingerprint) {
        emit(right, "CG205", `Function ${right.name} repeats the implementation of ${left.name}. Consider reusing a shared helper.`, 1, left);
        continue;
      }
      const overlap = [...left.calls].filter(call => right.calls.has(call)).length;
      if (overlap < 2 || overlap / Math.max(left.calls.size, right.calls.size) < 0.7) continue;
      const verdict = await score({
        premise: `Function ${left.name}: ${evidence(left)} Function ${right.name}: ${evidence(right)}`,
        same: "these functions duplicate the same behaviour and should share a helper",
        different: "these functions implement distinct behaviour despite similar calls"
      });
      if (supportsReuse(verdict)) emit(right, "CG205", `Function ${right.name} may duplicate ${left.name}. Review before extracting a helper.`, verdict.sameConcept, left);
    }
  }
}

export async function functionQuality(project: Project, includeTests = false, score: SemanticScorer = zeroShot): Promise<Finding[]> {
  const functions = getInfo(project, includeTests);
  const findings: Finding[] = [];
  const emit: Emit = (info, code, message, similarity, related) => {
    findings.push({ guard: "function-quality", severity: "warning", code, message,
      location: location(project.root, info.node),
      ...(similarity === undefined ? {} : { similarity }),
      ...(related ? { related: location(project.root, related.node) } : {})
    });
  };
  for (const info of functions) await reviewFunction(info, score, emit);
  await reviewSimilarFunctions(functions, score, emit);
  return findings;
}
