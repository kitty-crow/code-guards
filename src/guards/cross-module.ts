import ts from "typescript";
import path from "node:path";
import { location, type Finding } from "../model.ts";
import type { EmitIssue } from "./issue.ts";
import type { Project } from "../project.ts";

type Constant = { name: string; literal: string; node: ts.VariableDeclaration };
type Add = EmitIssue;

function words(text: string): Set<string> {
  return new Set(text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(token => token.length > 2));
}

function alike(left: string, right: string): boolean {
  const a = words(left);
  const b = words(right);
  const common = [...a].filter(token => b.has(token)).length;
  return left === right || common >= 1 && common / Math.max(a.size, b.size) >= 0.5;
}

function stringConstant(node: ts.Node): Constant | null {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return null;
  if (!ts.isVariableDeclarationList(node.parent) || !(node.parent.flags & ts.NodeFlags.Const)) return null;
  const initializer = node.initializer ?? null;
  if (!initializer || !ts.isStringLiteral(initializer) || initializer.text.length < 12) return null;
  return {name: node.name.text, literal: initializer.text, node};
}

function inspectConstants(project: Project, add: Add): void {
  const constants: Constant[] = [];
  for (const file of project.files) {
    if (/(?:^|\/)(?:test|tests|examples)\//.test(path.relative(project.root, file.fileName).replace(/\\/g, "/"))) continue;
    const visit = (node: ts.Node): void => {
      const constant = stringConstant(node);
      if (constant) constants.push(constant);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const groups = new Map<string, Constant[]>();
  for (const constant of constants) groups.set(constant.literal, [...(groups.get(constant.literal) ?? []), constant]);
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      const one = group[i] ?? null;
      if (!one) continue;
      for (const two of group.slice(i + 1)) {
        if (two.node.getSourceFile() === one.node.getSourceFile() || !alike(one.name, two.name)) continue;
        add({guard: "single-source", code: "CG304", node: two.node, message: "Duplicate configuration value maintained separately", reason: `Both ${one.name} and ${two.name} contain the same ${two.literal.length}-character string in different modules. Independent changes could cause configuration drift.`, suggestion: `Import ${one.name} from its owning module, or move both definitions into a shared configuration module.`, related: one.node});
      }
    }
  }
}

function inspectConventions(project: Project, add: Add): void {
  const clients: ts.Node[] = [];
  const direct: ts.Node[] = [];
  for (const file of project.files) {
    if (/(?:^|\/)(?:test|tests|examples)\//.test(path.relative(project.root, file.fileName).replace(/\\/g, "/"))) continue;
    const visit = (node: ts.Node): void => {
      const name = ts.isFunctionDeclaration(node) ? node.name ?? null : null;
      if (name && /^(?:apiClient|requestJson|httpClient|fetchWithAuth)$/i.test(name.text)) clients.push(node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^(?:apiClient|httpClient)$/i.test(node.name.text)) clients.push(node);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") direct.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const canonical = clients[0] ?? null;
  if (!canonical) return;
  for (const call of direct) {
    if (call.getSourceFile() === canonical.getSourceFile()) continue;
    add({guard: "project-conventions", code: "CG309", node: call, message: "Direct HTTP request bypasses the project API client", reason: "Other modules define a central HTTP client, but this call uses fetch directly. It may omit shared auth, retry or error-handling behaviour.", suggestion: "Check whether the existing API client supports this request and use it if it provides the same semantics.", related: canonical});
  }
}

export function crossModule(project: Project): Finding[] {
  const findings: Finding[] = [];
  const add: Add = item => {
    const {guard, code, node, message, reason, suggestion} = item;
    const line = node.getText().split("\n", 1)[0] ?? "";
    findings.push({guard, code, severity: "warning", message, location: location(project.root, node), span: Math.min(85, node.getWidth()), subject: line.slice(0, 115), reason, suggestion, ...("related" in item ? {related: location(project.root, item.related)} : {})});
  };
  inspectConstants(project, add);
  inspectConventions(project, add);
  return findings;
}
