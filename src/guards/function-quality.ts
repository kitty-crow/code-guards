import { withoutIgnored } from "../model.ts";
import ts from "typescript";
import path from "node:path";
import { location, type Finding, type Location } from "../model.ts";
import type { CodeExpert, SourceEvidence, ProseMatch } from "../experts.ts";
import { isTestFile, type Project } from "../project.ts";
import { supportsReuse, zeroShot, semanticConcurrency, comparisonQuestion, type SemanticScorer } from "../semantic.ts";
import { orderedConcurrentMap } from "../inference-scheduler.ts";

type BehaviourFacts = {
  signature: string;
  returnDomain: string;
  references: string[];
  writes: number;
  throws: number;
  awaits: number;
  returns: number;
};

type FunctionInfo = {
  name: string;
  node: ts.Node;
  body: ts.Block | ts.ConciseBody;
  lines: number;
  branches: number;
  branchClauses: string[];
  statements: number;
  dependencies: Set<string>;
  calls: Set<string>;
  callTargets: string[];
  contract: boolean;
  comments: boolean;
  arguments: number;
  fingerprint: string;
  behaviour: BehaviourFacts;
};

function functionName(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = node.name ?? null;
    return name ? name.getText() : "";
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const expression = ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  if (expression && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (expression && ts.isPropertyAssignment(node.parent)) return node.parent.name.getText();
  return "";
}

function resolvedDeclaration(project: Project, node: ts.Node): ts.Declaration | null {
  const reference = project.checker.getSymbolAtLocation(node) ?? null;
  const symbol = reference && (reference.flags & ts.SymbolFlags.Alias)
    ? project.checker.getAliasedSymbol(reference) : reference;
  return symbol ? (symbol.declarations ?? [])[0] ?? null : null;
}

function declarationIdentity(project: Project, declaration: ts.Declaration): string {
  const source = declaration.getSourceFile();
  return `${path.relative(project.root, source.fileName).replace(/\\/g, "/")}:${declaration.getStart(source)}`;
}

function recordCall(project: Project, file: ts.SourceFile, node: ts.CallExpression, info: FunctionInfo): void {
  const target = node.expression;
  info.calls.add(target.getText(file));
  const first = resolvedDeclaration(project, ts.isPropertyAccessExpression(target) ? target.name : target);
  if (!first) {
    info.callTargets.push(`unresolved:${path.relative(project.root, file.fileName)}:${target.getText(file)}`);
    return;
  }
  const source = first.getSourceFile();
  info.callTargets.push(declarationIdentity(project, first));
  if (source !== file && !source.isDeclarationFile) info.dependencies.add(source.fileName);
}

function branchClause(node: ts.Node): string {
  if (ts.isIfStatement(node)) return `if (${node.expression.getText()})`;
  if (ts.isConditionalExpression(node)) return `conditional (${node.condition.getText()})`;
  if (ts.isWhileStatement(node)) return `while (${node.expression.getText()})`;
  const condition = ts.isForStatement(node) ? node.condition ?? null : null;
  if (condition) return `for (${condition.getText()})`;
  if (ts.isCaseClause(node)) return `case ${node.expression.getText()}`;
  return "";
}

// A method required by an explicit base or interface contract cannot be removed
// solely because its body does not read instance state.
function requiredMethod(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (!ts.isMethodDeclaration(node)) return false;
  const modifiers = ts.getModifiers(node) ?? [];
  if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.OverrideKeyword)) return true;
  const parent = node.parent;
  if (!ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) return false;
  const symbol = checker.getSymbolAtLocation(node.name) ?? null;
  if (!symbol) return false;
  const heritage = (parent.heritageClauses ?? []).flatMap(clause => clause.types);
  return heritage.some(item => (checker.getPropertyOfType(checker.getTypeAtLocation(item), symbol.name) ?? null) !== null);
}

// Local bindings can be identical across two implementations; references to
// declarations outside the function must retain their compiler identity.
function externalReferences(project: Project, scope: ts.Node): string[] {
  const file = scope.getSourceFile();
  const references = new Set<string>();
  const walk = (node: ts.Node): void => {
    const declaration = ts.isIdentifier(node) ? resolvedDeclaration(project, node) : null;
    const local = declaration !== null && declaration.getSourceFile() === file &&
      declaration.pos >= scope.pos && declaration.end <= scope.end;
    if (declaration && !local) references.add(node.getText() + ":" + declarationIdentity(project, declaration));
    ts.forEachChild(node, walk);
  };
  walk(scope);
  return [...references].sort();
}

// Only disjoint primitive return domains are conclusive here. Unions,
// generics and object contracts need semantic or assignability evidence.
function returnDomain(type: ts.Type): string {
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.BigIntLike) return "bigint";
  if (type.flags & ts.TypeFlags.ESSymbolLike) return "symbol";
  return "";
}

function behaviourFacts(project: Project, node: ts.SignatureDeclaration): BehaviourFacts {
  const signature = project.checker.getSignatureFromDeclaration(node) ?? null;
  return {
    signature: signature ? project.checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation) : "",
    returnDomain: signature ? returnDomain(project.checker.getReturnTypeOfSignature(signature)) : "",
    references: externalReferences(project, node), writes: 0, throws: 0, awaits: 0, returns: 0
  };
}

function recordEffects(node: ts.Node, facts: BehaviourFacts): void {
  if (ts.isReturnStatement(node)) facts.returns += 1;
  if (ts.isThrowStatement(node)) facts.throws += 1;
  if (ts.isAwaitExpression(node)) facts.awaits += 1;
  if (ts.isDeleteExpression(node)) facts.writes += 1;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) facts.writes += 1;
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) facts.writes += 1;
}

function getInfo(project: Project, includeTests: boolean): FunctionInfo[] {
  const result: FunctionInfo[] = [];
  for (const file of project.files) {
    if (!includeTests && isTestFile(file.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (!ts.isFunctionLike(node)) { ts.forEachChild(node, visit); return; }
      const name = functionName(node);
      const body = "body" in node ? node.body ?? null : null;
      if (!name || !body) { ts.forEachChild(node, visit); return; }
      const info: FunctionInfo = {
        name, node, body, lines: 0, branches: 0, branchClauses: [], statements: 0,
        dependencies: new Set(), calls: new Set(), callTargets: [], contract: requiredMethod(node, project.checker),
        comments: false, arguments: node.parameters.length, fingerprint: "", behaviour: behaviourFacts(project, node)
      };
      const start = file.getLineAndCharacterOfPosition(body.getStart(file)).line;
      const end = file.getLineAndCharacterOfPosition(body.getEnd()).line;
      info.lines = end - start + 1;
      const text = body.getText(file);
      const leadingComments = ts.getLeadingCommentRanges(file.text, node.getFullStart()) ?? [];
      info.comments = /\/\/|\/\*/.test(text) || leadingComments.length > 0;
      const visitBody = (current: ts.Node): void => {
        if (current !== body && ts.isFunctionLike(current)) return;
        if (ts.isStatement(current) && current !== body) info.statements += 1;
        if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isForStatement(current) || ts.isForOfStatement(current) || ts.isForInStatement(current) || ts.isWhileStatement(current) || ts.isCaseClause(current) || ts.isCatchClause(current)) info.branches += 1;
        const clause = info.branchClauses.length < 5 ? branchClause(current) : "";
        if (clause) {
          const line = file.getLineAndCharacterOfPosition(current.getStart(file)).line + 1;
          info.branchClauses.push(`${clause} (line ${line})`);
        }
        if (ts.isCallExpression(current)) recordCall(project, file, current, info);
        recordEffects(current, info.behaviour);
        ts.forEachChild(current, visitBody);
      };
      visitBody(body);
      // The printer removes trivia without altering literal content or call names.
      // Resolved call targets distinguish equally named operations in different modules.
      const printed = ts.createPrinter({removeComments: true}).printNode(ts.EmitHint.Unspecified, body, file);
      info.fingerprint = JSON.stringify([printed, info.callTargets, info.behaviour.signature, info.behaviour.references]);
      result.push(info);
      ts.forEachChild(node, child => { if (child !== body) visit(child); });
    };
    visit(file);
  }
  return result;
}

function evidence(info: FunctionInfo): string {
  const excerpt = info.body.getText().replace(/\s+/g, " ").slice(0, 360);
  return `The TypeScript function ${info.name} is ${info.lines} lines long, contains ${info.branches} decision branches, ${info.statements} statements, takes ${info.arguments} arguments, and calls ${[...info.calls].slice(0, 12).join(", ") || "nothing"}. It uses ${info.dependencies.size} external source modules. ${info.comments ? "It contains comments." : "It has no explanatory comments."} Example clauses: ${info.branchClauses.join("; ")}. Implementation excerpt: ${excerpt}`;
}

function behaviouralEvidence(info: FunctionInfo): string {
  const facts = info.behaviour;
  return `Typed contract: ${facts.signature}. Explicit syntax: ${facts.writes} writes, ${facts.throws} throws, ${facts.awaits} awaits, ${facts.returns} returns. Resolved external references: ${facts.references.join(", ") || "none"}. Resolved calls: ${info.callTargets.join(", ") || "none"}. Implementation: ${info.body.getText()}`;
}

function compareBehaviour(left: FunctionInfo, right: FunctionInfo) {
  const a = behaviouralEvidence(left);
  const b = behaviouralEvidence(right);
  return comparisonQuestion({
    premise: `First function ${left.name}: ${a}\nSecond function ${right.name}: ${b}`,
    same: "these functions duplicate the same behaviour and public contract, including inputs, outputs and effects, so a shared implementation would preserve behaviour",
    different: "these functions have distinct contracts, transformations, dependencies, state changes or error conditions despite similar code"
  }, {name: left.name, evidence: a}, {name: right.name, evidence: b});
}

type Emit = (info: FunctionInfo, code: string, similarity: number, related: FunctionInfo | null) => void;

async function reviewFunction(info: FunctionInfo, score: SemanticScorer, emit: Emit): Promise<void> {
  const checks = [
    { trigger: info.lines >= 45 && info.branches >= 4, code: "CG201", suggestion: "this function has multiple responsibilities and should be split into smaller focused functions", opposite: "this function is cohesive and should remain one function" },
    { trigger: info.lines >= 25 && info.branches >= 3 && !info.comments, code: "CG202", suggestion: "this function needs explanatory comments describing non-obvious decisions and invariants", opposite: "this function is self-explanatory and needs no comments" },
    { trigger: info.dependencies.size >= 4, code: "CG203", suggestion: "this function depends on too many external modules and may belong in a different module", opposite: "the function has appropriate modular dependencies" },
    { trigger: ts.isMethodDeclaration(info.node) && !info.contract && info.lines <= 6 && info.statements <= 2 && !/\b(?:this|super)\b/.test(info.body.getText()), code: "CG204", suggestion: "this short stateless method could be a standalone helper or arrow function instead of a class method", opposite: "this method belongs to the class and needs its own method declaration" }
  ];
  for (const check of checks) {
    if (!check.trigger) continue;
    const verdict = await score({ premise: evidence(info), same: check.suggestion, different: check.opposite });
    if (supportsReuse(verdict, 0.75)) emit(info, check.code, verdict.sameConcept, null);
  }
}

function incompatibleReturns(left: FunctionInfo, right: FunctionInfo): boolean {
  const a = left.behaviour.returnDomain;
  const b = right.behaviour.returnDomain;
  return a !== "" && b !== "" && a !== b;
}

function baselineComparison(left: FunctionInfo, right: FunctionInfo): boolean {
  // CG205 concerns equivalent whole implementations, not arbitrary shared
  // subexpressions. Disjoint primitive outputs refute contract equivalence.
  if (incompatibleReturns(left, right)) return false;
  if (left.statements < 3 || right.statements < 3 || right.node.getSourceFile() === left.node.getSourceFile()) return false;
  if (Math.abs(left.statements - right.statements) > 2 || Math.abs(left.arguments - right.arguments) > 1) return false;
  if (left.fingerprint === right.fingerprint) return true;
  const overlap = [...left.calls].filter(call => right.calls.has(call)).length;
  return overlap >= 2 && overlap / Math.max(left.calls.size, right.calls.size) >= 0.7;
}

async function reviewSimilarFunctions(functions: FunctionInfo[], score: SemanticScorer, emit: Emit): Promise<void> {
  // Exact duplicates are deterministic. Near-duplicates are sent to MNLI only
  // after statement count and overlapping call-site checks narrow the pairs.
  for (let i = 0; i < functions.length; i += 1) {
    const left = functions[i] ?? null;
    if (!left || left.statements < 3) continue;
    for (const right of functions.slice(i + 1)) {
      if (!baselineComparison(left, right)) continue;
      if (left.fingerprint === right.fingerprint) {
        emit(right, "CG205", 1, left);
        continue;
      }
      const verdict = await score(compareBehaviour(left, right));
      if (supportsReuse(verdict)) emit(right, "CG205", verdict.sameConcept, left);
    }
  }
}

function evidenceKey(place: Location): string {
  return JSON.stringify([place.file, place.line, place.column]);
}

function codeCohorts(functions: FunctionInfo[]): FunctionInfo[][] {
  const byArity = new Map<number, FunctionInfo[]>();
  for (const info of functions.filter(item => item.statements >= 3)) {
    const group = byArity.get(info.arguments) ?? [];
    group.push(info);
    byArity.set(info.arguments, group);
  }
  // Bound exact nearest-neighbour retrieval; the existing cross-project
  // structural and call-overlap candidate path remains independent.
  const cohorts: FunctionInfo[][] = [];
  for (const group of byArity.values()) {
    if (group.length > 256) console.error("[Code Guards] Experimental code retrieval partitions a cohort of " + group.length + " functions; cross-partition pairs use the baseline detector.");
    for (let offset = 0; offset < group.length; offset += 256) cohorts.push(group.slice(offset, offset + 256));
  }
  return cohorts;
}

function codeEvidence(info: FunctionInfo, project: Project): SourceEvidence {
  return {location: location(project.root, nameNode(info)), text: info.node.getText()};
}

async function retrieveCodePairs(functions: FunctionInfo[], project: Project, expert: CodeExpert): Promise<ProseMatch[]> {
  const results: ProseMatch[] = [];
  for (const cohort of codeCohorts(functions)) {
    const passages = cohort.map(info => codeEvidence(info, project));
    const indexed = new Map(cohort.map(info => [evidenceKey(location(project.root, nameNode(info))), info]));
    const eligible = (a: SourceEvidence, b: SourceEvidence): boolean => {
      const left = indexed.get(evidenceKey(a.location)) ?? null;
      const right = indexed.get(evidenceKey(b.location)) ?? null;
      return left !== null && right !== null && a.location.file !== b.location.file && !incompatibleReturns(left, right) && !baselineComparison(left, right);
    };
    if (!passages.some((a, index) => passages.slice(index + 1).some(b => eligible(a, b)))) continue;
    const retrieval = await expert.rank(passages, eligible);
    for (const item of retrieval.unresolved) console.error(`[Code Guards] Code retrieval could not encode the complete implementation at ${item.location.file}:${item.location.line}.`);
    results.push(...retrieval.matches);
  }
  return results;
}

async function reviewRetrievedFunctions(functions: FunctionInfo[], project: Project, expert: CodeExpert, score: SemanticScorer, emit: Emit): Promise<void> {
  let pairs: ProseMatch[] = [];
  try { pairs = await retrieveCodePairs(functions, project, expert); }
  finally { await expert.close(); }
  // The code specialist has finished its retrieval task before the final
  // judge evaluates behaviour. Relevance is never a verdict on duplication.
  const indexed = new Map(functions.map(info => [evidenceKey(location(project.root, nameNode(info))), info]));
  for (const pair of pairs) {
    const left = indexed.get(evidenceKey(pair.earlier.location)) ?? null;
    const right = indexed.get(evidenceKey(pair.later.location)) ?? null;
    if (!left || !right) throw new Error("Code retrieval returned an unknown source location.");
    const verdict = await score(compareBehaviour(left, right));
    if (supportsReuse(verdict)) emit(right, "CG205", verdict.sameConcept, left);
  }
}

function nameNode(info: FunctionInfo): ts.Node {
  const node = info.node;
  if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.name ?? node;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) return node.parent.name;
  return node;
}

type Explanation = { title: string; reason: string; suggestion: string };

// These suggestions are deliberately conditional: similar syntax does not
// establish that two functions have the same contract or side effects.
function explain(info: FunctionInfo, code: string, related: FunctionInfo | null): Explanation {
  const measurements = `${info.lines} lines, ${info.statements} statements and ${info.branches} decision points`;
  const clauses = info.branchClauses.slice(0, 3).join("; ");
  if (code === "CG201") return {
    title: `Consider decomposing ${info.name}`,
    reason: `${info.name} contains ${measurements}. Example decisions: ${clauses}. The model agreed that decomposition may help.`,
    suggestion: `Inspect the branches in ${info.name}; extract distinct validation, transformation or output phases into named helpers, then keep ${info.name} as an orchestrator. Preserve execution order and side effects.`
  };
  if (code === "CG202") return {
    title: `Unexplained decisions in ${info.name}`,
    reason: `${info.name} contains ${info.branches} decision points across ${info.lines} lines, but no explanatory comment was detected. Example clauses: ${clauses}. The model agreed that a comment could help.`,
    suggestion: `Add a short comment or JSDoc immediately before ${info.name} describing the non-obvious rule or invariant behind its branches. Explain why the condition matters, not what each statement does.`
  };
  if (code === "CG203") {
    const modules = [...info.dependencies].map(filename => path.basename(filename)).sort().join(", ");
    return {
      title: `High external coupling in ${info.name}`,
      reason: `${info.name} calls into ${info.dependencies.size} other source modules: ${modules}. The model agreed that the ownership or dependency boundary warrants review.`,
      suggestion: `Review whether ${info.name} belongs in a coordinating module. Consider passing narrower interfaces, grouping related operations or moving orchestration to an explicit service. Avoid moving it solely to reduce a metric.`
    };
  }
  if (code === "CG204") return {
    title: `Stateless method ${info.name} might be a helper`,
    reason: `${info.name} has ${info.statements} statements and ${info.lines} lines with no detected 'this' or 'super' use. The model agreed that a helper could be clearer.`,
    suggestion: `If ${info.name} does not rely on class identity or an override contract, consider a module-level function or arrow-function helper and call it from the class. Check public API compatibility before changing it.`
  };
  const other = related ? related.name : "another function";
  return {
    title: `Repeated implementation: ${info.name} and ${other}`,
    reason: related && related.fingerprint === info.fingerprint
      ? `${info.name} has the same normalised function body as ${other} (in ${path.basename(related.node.getSourceFile().fileName.replace(/\\/g, "/"))}).`
      : `${info.name} and ${other} were shortlisted by structural or semantic retrieval evidence and the zero-shot model suggested duplicated behaviour.`,
    suggestion: `Compare ${info.name} with ${other} and their contracts. If they genuinely perform the same operation, keep one shared implementation and import or delegate to it; otherwise preserve separate domain-specific functions.`
  };
}

export async function functionQuality(project: Project, includeTests = false, score: SemanticScorer = zeroShot, expert: CodeExpert | null = null): Promise<Finding[]> {
  const functions = getInfo(project, includeTests);
  const findings: Finding[] = [];
  const emit: Emit = (info, code, similarity, related) => {
    const note = explain(info, code, related);
    findings.push({ guard: "function-quality", severity: "warning", code, message: note.title,
      location: location(project.root, nameNode(info)),
      subject: info.name,
      span: info.name.length,
      reason: note.reason,
      suggestion: note.suggestion,
      similarity,
      ...(related ? { related: location(project.root, nameNode(related)), relatedSpan: related.name.length } : {})
    });
  };
  // Independent function questions run concurrently on the physical GPU pool.
  // Collect per-function findings in source order to preserve stable diagnostics.
  const reviewed = await orderedConcurrentMap(functions, semanticConcurrency(), async info => {
    const local: Finding[] = [];
    const localEmit: Emit = (target, code, similarity, related) => {
      const note = explain(target, code, related);
      local.push({ guard: "function-quality", severity: "warning", code, message: note.title,
        location: location(project.root, nameNode(target)),
        subject: target.name, span: target.name.length,
        reason: note.reason, suggestion: note.suggestion, similarity,
        ...(related ? { related: location(project.root, nameNode(related)),
          relatedSpan: related.name.length } : {})
      });
    };
    await reviewFunction(info, score, localEmit);
    return local;
  });
  for (const result of reviewed) findings.push(...result);
  await reviewSimilarFunctions(functions, score, emit);
  if (expert) await reviewRetrievedFunctions(functions, project, expert, score, emit);
  return withoutIgnored(project.root, findings);
}
