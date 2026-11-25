import { withoutIgnored } from "../model.ts";
import path from "node:path";
import ts from "typescript";
import { location, type Finding } from "../model.ts";
import { isTestFile, type Project } from "../project.ts";
import { supportsReuse, zeroShot, comparisonQuestion, type SemanticScorer } from "../semantic.ts";

type Unit = {
  name: string;
  node: ts.Node;
  operations: string[];
  references: Set<ts.Symbol>;
  symbol: ts.Symbol | null;
  implementation: string;
  detail: string;
};


function inspect(project: Project, file: ts.SourceFile, name: string, node: ts.Node, body: ts.Node): Unit {
  const operations = new Set<string>();
  const references = new Set<ts.Symbol>();
  const recordCall = (expression: ts.LeftHandSideExpression): void => {
    if (operations.size < 10) operations.add(expression.getText(file).slice(0, 64));

  };
  const walk = (current: ts.Node): void => {
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) recordCall(current.expression);
    const symbol = ts.isIdentifier(current) ? project.checker.getSymbolAtLocation(current) ?? null : null;
    if (symbol) references.add(symbol.flags & ts.SymbolFlags.Alias ? project.checker.getAliasedSymbol(symbol) : symbol);
    ts.forEachChild(current, walk);
  };
  walk(body);
  const preview = body.getText(file).replace(/\s+/g, " ").slice(0, 210);
  const symbol = project.checker.getSymbolAtLocation(node) ?? null;
  return {name, node, operations: [...operations], references, symbol, implementation: body.getText(file), detail: preview};
}

function implemented(member: ts.ClassElement): boolean {
  if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return Boolean(member.body ?? null);
  }
  return false;
}

function classUnit(project: Project, file: ts.SourceFile, statement: ts.ClassDeclaration): Unit[] {
  const name = statement.name ?? null;
  if (!name) return [];
  const implementations = statement.members.filter(implemented);
  if (!implementations.length) return [];
  const unit = inspect(project, file, name.text, name, statement);
  const methods = implementations.flatMap(member => {
    if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      return [member.name.getText(file)];
    }
    return ts.isConstructorDeclaration(member) ? ["constructor"] : [];
  });
  unit.detail = `Class methods: ${methods.join(", ")}. ${unit.detail}`;
  return [unit];
}

function variableUnits(project: Project, file: ts.SourceFile, statement: ts.VariableStatement): Unit[] {
  const result: Unit[] = [];
  for (const declaration of statement.declarationList.declarations) {
    const initializer = declaration.initializer ?? null;
    if (!initializer || !ts.isIdentifier(declaration.name)) continue;
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      result.push(inspect(project, file, declaration.name.text, declaration.name, initializer.body));
      continue;
    }
    if (ts.isCallExpression(initializer) || ts.isNewExpression(initializer) || ts.isAwaitExpression(initializer)) {
      result.push(inspect(project, file, `initialisation of ${declaration.name.text}`, declaration.name, initializer));
    }
  }
  return result;
}

function functionUnit(project: Project, file: ts.SourceFile, statement: ts.FunctionDeclaration): Unit[] {
  const name = statement.name ?? null;
  const body = statement.body ?? null;
  return name && body ? [inspect(project, file, name.text, name, body)] : [];
}

function statementUnits(project: Project, file: ts.SourceFile, statement: ts.Statement): Unit[] {
  if (ts.isFunctionDeclaration(statement)) return functionUnit(project, file, statement);
  if (ts.isClassDeclaration(statement)) return classUnit(project, file, statement);
  if (ts.isVariableStatement(statement)) return variableUnits(project, file, statement);
  if (!ts.isExpressionStatement(statement)) return [];
  if (!ts.isCallExpression(statement.expression) && !ts.isAwaitExpression(statement.expression)) return [];
  const line = file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1;
  return [inspect(project, file, `top-level operation at line ${line}`, statement, statement.expression)];
}

// A declaration is collected by its implementation shape, so helpers, classes
// and script initialisation remain separate units without nesting AST tests.
function operations(project: Project, file: ts.SourceFile): Unit[] {
  return file.statements.flatMap(statement => statementUnits(project, file, statement));
}

function dependsOn(left: Unit, right: Unit): boolean {
  return right.symbol !== null && left.references.has(right.symbol);
}

function related(left: Unit, right: Unit): boolean {
  return dependsOn(left, right) || dependsOn(right, left);
}

function evidence(unit: Unit): string {
  return `${unit.name}: calls ${unit.operations.join(", ") || "none"}; implementation: ${unit.detail}`;
}

// Sample the complete implementation for semantic context, including its tail.
// Sampling bounds the model input, but never decides whether to warn.
function overview(units: Unit[]): string {
  const count = Math.min(units.length, 14);
  const selected = new Set<number>();
  for (let i = 0; i < count; i += 1) {
    selected.add(count === 1 ? 0 : Math.round(i * (units.length - 1) / (count - 1)));
  }
  return [...selected].map(index => {
    const unit = units[index] ?? null;
    if (!unit) return "";
    return `${unit.name}: ${unit.operations.slice(0, 3).join(", ") || "local computation"}; ${unit.detail.slice(0, 85)}`;
  }).join(" | ");
}

function breakout(anchor: Unit, other: Unit, all: Unit[]): string {
  const members = all.filter(unit => unit === anchor || (
    dependsOn(anchor, unit) && unit !== other && !dependsOn(other, unit)
  ));
  const names = members.map(unit => unit.name).join(", ");
  const actions = anchor.operations.slice(0, 4).join(", ");
  const purpose = anchor.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return `module focused on ${purpose} (declarations: ${names}; operations: ${actions || "local computation"})`;
}

/**
 * Detect independently useful responsibilities in the same source module.
 * Source length, branch count and declaration count do not determine a warning.
 * AST evidence identifies operations; zero-shot inference judges cohesion.
 */
export async function moduleCohesion(
  project: Project, includeTests = false, score: SemanticScorer = zeroShot
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const file of project.files) {
    const relative = path.relative(project.root, file.fileName).replace(/\\/g, "/");
    if (!includeTests && isTestFile(relative)) continue;
    const units = operations(project, file);
    const pairs: {left: Unit; right: Unit}[] = [];
    for (const [index, left] of units.entries()) {
      for (const right of units.slice(index + 1)) {
        if (!related(left, right)) pairs.push({left, right});
      }
    }
    if (!pairs.length) continue;

    const moduleVerdict = await score({
      premise: `TypeScript module ${relative} contains these implemented operations: ${overview(units)}`,
      same: "this module combines separate operational responsibilities that could be maintained as focused modules with distinct purposes",
      different: "these operations implement a single cohesive responsibility or deliberately coordinate one workflow"
    });
    if (!supportsReuse(moduleVerdict, 0.8) || moduleVerdict.differentConcept > 0.4) continue;

    // A second, concrete judgement must identify separable operations.
    // A large, cohesive module receives no warning merely for its size.
    for (const {left, right} of pairs.sort((a, b) => Math.abs(b.right.node.pos - b.left.node.pos) - Math.abs(a.right.node.pos - a.left.node.pos)).slice(0, 24)) {
      const verdict = await score(comparisonQuestion({
        premise: `Two implementations in one TypeScript module. First: ${left.name}: ${left.implementation}. Second: ${right.name}: ${right.implementation}.`,
        same: "these implementations have independent responsibilities and should be placed in distinct focused modules",
        different: "these implementations are related parts of one responsibility, share a contract, or deliberately coordinate a single workflow"
      }, {name: left.name, evidence: left.implementation}, {name: right.name, evidence: right.implementation}));
      if (!supportsReuse(verdict, 0.82) || verdict.differentConcept > 0.38) continue;
      const leftGroup = breakout(left, right, units);
      const rightGroup = breakout(right, left, units);
      findings.push({
        guard: "module-cohesion", severity: "warning", code: "CG206",
        message: "Module combines independent responsibilities",
        location: location(project.root, left.node),
        related: location(project.root, right.node),
        subject: `${left.name} / ${right.name}`,
        reason: `The module-level model supports splitting responsibilities (${Math.round(moduleVerdict.sameConcept * 100)}%). The two implementations also received ${Math.round(verdict.sameConcept * 100)}% support for independence and ${Math.round(verdict.differentConcept * 100)}% for cohesion. Evidence: ${evidence(left)}; ${evidence(right)}.`,
        suggestion: `Proposed responsibility breakout: (1) ${leftGroup}; (2) ${rightGroup}. Move each group into its own focused module. Keep common helpers shared and retain a thin orchestrator only if it coordinates these operations. Review remaining declarations by their actual responsibilities and preserve public contracts.`
      });
      break;
    }
  }
  return withoutIgnored(project.root, findings);
}
