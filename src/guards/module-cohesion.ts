import path from "node:path";
import ts from "typescript";
import { location, type Finding } from "../model.ts";
import type { Project } from "../project.ts";
import { supportsReuse, zeroShot, type SemanticScorer } from "../semantic.ts";

type Unit = {
  name: string;
  node: ts.Node;
  operations: string[];
  localCalls: Set<string>;
  detail: string;
};

const testFile = /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|\.(?:test|spec)\.[cm]?tsx?$/;

function inspect(file: ts.SourceFile, name: string, node: ts.Node, body: ts.Node): Unit {
  const operations = new Set<string>();
  const localCalls = new Set<string>();
  const walk = (current: ts.Node): void => {
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      const expression = current.expression;
      if (operations.size < 10) operations.add(expression.getText(file).slice(0, 64));
      if (ts.isIdentifier(expression)) localCalls.add(expression.text);
    }
    ts.forEachChild(current, walk);
  };
  walk(body);
  const preview = body.getText(file).replace(/\s+/g, " ").slice(0, 210);
  return {name, node, operations: [...operations], localCalls, detail: preview};
}

function operations(file: ts.SourceFile): Unit[] {
  const result: Unit[] = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      result.push(inspect(file, statement.name.text, statement.name, statement.body));
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      const implementations = statement.members.filter(member => "body" in member && member.body);
      if (!implementations.length) continue;
      const unit = inspect(file, statement.name.text, statement.name, statement);
      const methods = implementations.map(member => member.name?.getText(file)).filter((name): name is string => Boolean(name));
      unit.detail = `Class methods: ${methods.join(", ")}. ${unit.detail}`;
      result.push(unit);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (!initializer || !ts.isIdentifier(declaration.name)) continue;
        if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) continue;
        result.push(inspect(file, declaration.name.text, declaration.name, initializer.body));
      }
      continue;
    }
    if (ts.isExpressionStatement(statement) && (
      ts.isCallExpression(statement.expression) || ts.isAwaitExpression(statement.expression)
    )) {
      const line = file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1;
      result.push(inspect(file, `top-level operation at line ${line}`, statement, statement.expression));
    }
  }
  return result;
}

function related(left: Unit, right: Unit): boolean {
  return left.localCalls.has(right.name) || right.localCalls.has(left.name);
}

function evidence(unit: Unit): string {
  return `${unit.name}: calls ${unit.operations.join(", ") || "none"}; implementation: ${unit.detail}`;
}

function breakout(anchor: Unit, other: Unit, all: Unit[]): string {
  const members = all.filter(unit => unit === anchor || (
    anchor.localCalls.has(unit.name) && unit !== other && !other.localCalls.has(unit.name)
  ));
  const names = members.map(unit => unit.name).join(", ");
  const actions = anchor.operations.slice(0, 4).join(", ");
  return `${anchor.name} responsibility (declarations: ${names}; operations: ${actions || "local computation"})`;
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
    if (!includeTests && testFile.test(relative)) continue;
    const units = operations(file);
    const pairs: {left: Unit; right: Unit}[] = [];
    for (const [index, left] of units.entries()) {
      for (const right of units.slice(index + 1)) {
        if (!related(left, right)) pairs.push({left, right});
      }
    }
    if (!pairs.length) continue;

    const moduleVerdict = await score({
      premise: `TypeScript module ${relative} contains these implemented operations: ${units.map(evidence).join(" | ").slice(0, 1400)}`,
      same: "this module combines separate operational responsibilities that could be maintained as focused modules with distinct purposes",
      different: "these operations implement a single cohesive responsibility or deliberately coordinate one workflow"
    });
    if (!supportsReuse(moduleVerdict, 0.8) || moduleVerdict.differentConcept > 0.4) continue;

    // A second, concrete judgement must identify separable operations.
    // A large, cohesive module receives no warning merely for its size.
    for (const {left, right} of pairs.slice(0, 24)) {
      const verdict = await score({
        premise: `Two implementations in one TypeScript module. First: ${evidence(left)}. Second: ${evidence(right)}.`,
        same: "these implementations have independent responsibilities and should be placed in distinct focused modules",
        different: "these implementations are related parts of one responsibility, share a contract, or deliberately coordinate a single workflow"
      });
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
  return findings;
}
