import { withoutIgnored } from "../model.ts";
import path from "node:path";
import ts from "typescript";
import { location, type Finding, type Location } from "../model.ts";
import type { Project } from "../project.ts";

/** Declaration-based naming review; each declaration is reported once, not at every use. */
const suffixes = new Set(["manager", "service", "handler", "processor", "coordinator", "provider", "factory", "builder", "implementation", "wrapper", "utility", "helper", "controller", "component"]);
const filler = new Set(["very", "really", "actually", "currently", "specific", "that", "those", "which", "might", "need", "needs", "some", "all", "entire", "complete", "the", "this", "these", "for", "with", "and", "of", "to", "in", "order", "please", "perform", "execute", "operation", "functionality", "information", "are", "is", "being", "existing", "new", "custom", "various", "different", "multiple", "shortening"]);
const abbreviations: Readonly<Record<string, string>> = {
  long: "lng", names: "nms", name: "nm", calculate: "calc", calculation: "calc",
  customer: "cust", customers: "cust", configuration: "cfg", synchronisation: "sync",
  synchronization: "sync", processing: "proc", processor: "proc", validation: "valid",
  identifier: "id", identifiers: "ids", address: "addr", billing: "bill",
  authentication: "auth", application: "app", response: "resp", request: "req",
  document: "doc", documentation: "docs", transaction: "txn", management: "mgmt"
};
const testPath = /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|\.(?:test|spec)\.[cm]?tsx?$/;
const generated = /(?:^|[\\/])(?:generated|__generated__|gen|vendor|node_modules|dist)[\\/]|(?:\.generated|\.g|\.d)\.[cm]?tsx?$/i;

function words(name: string): string[] {
  return name.replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u).map(word => word.toLowerCase()).filter(Boolean);
}

function declarationName(node: ts.Node): ts.Identifier | ts.PrivateIdentifier | ts.StringLiteral | null {
  const named = ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isEnumMember(node) ||
    ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) || ts.isParameter(node) || ts.isTypeParameterDeclaration(node) ||
    ts.isModuleDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
    ts.isBindingElement(node) || ts.isImportSpecifier(node) || ts.isExportSpecifier(node) ||
    ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isNamespaceExport(node) ||
    ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node);
  if (!named) return null;
  // An unaliased import/export is a reference to a declaration in another file.
  if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && !(node.propertyName ?? null)) return null;
  const name = node.name ?? null;
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) ? name : null;
}

function category(node: ts.Node): string {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "class";
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isParameter(node)) return "parameter";
  if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) return "variable";
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isNamespaceImport(node)) return "alias";
  return "member";
}

function compact(parts: string[], style: "identifier" | "path"): string {
  const meaningful = parts.filter(part => !filler.has(part));
  const kept = meaningful.filter((part, index) => index < 2 || !suffixes.has(part)).slice(0, 3);
  if (!kept.length) return "a shorter domain-specific name";
  const selected = kept.map(part => abbreviations[part] ?? (part.length > 8 ? part.slice(0, 5) : part));
  if (style === "path") return `\`${selected.join("-")}\``;
  const camel = selected.map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)).join("");
  return `\`${camel}\``;
}

function inflated(parts: string[]): string | null {
  const architectural = parts.filter(part => suffixes.has(part));
  if (architectural.length >= 3) return `${architectural.length} stacked generic architecture suffixes (${architectural.join(", ")})`;
  const fillers = [...new Set(parts.filter(part => filler.has(part)))];
  if (parts.length >= 5 && fillers.length >= 2) return `filler words (${fillers.join(", ")})`;
  return null;
}

function overlong(name: string, parts: string[]): boolean {
  return name.length >= 48 || (name.length >= 34 && parts.length >= 5) || parts.length >= 8;
}

function warning(code: string, name: string, target: Location, reason: string, suggestion: string, span: number): Finding {
  const titles: Record<string, string> = {
    CG316: "Overdescriptive identifier",
    CG317: "Enterprise-style identifier with filler or stacked roles",
    CG318: "Overdescriptive filename or directory name"
  };
  return { guard: "enterprise-looking-naming", severity: "warning", code,
    message: titles[code] ?? "Overdescriptive name", location: target,
    subject: name, span, reason, suggestion };
}

// Review names only in eligible files; path and identifier findings describe separate naming decisions.
export function enterpriseLookingNaming(project: Project, includeTests = false): Finding[] {
  const findings: Finding[] = [];
  const seenDirectories = new Set<string>();
  for (const file of project.files) {
    if (generated.test(file.fileName) || (!includeTests && testPath.test(file.fileName))) continue;
    const relative = path.relative(project.root, file.fileName).split(path.sep).join("/");
    const segments = relative.split("/");
    for (const [index, segment] of segments.entries()) {
      const isFile = index === segments.length - 1;
      const stem = isFile ? segment.replace(/(?:\.(?:test|spec))?\.[cm]?tsx?$/i, "") : segment;
      const parts = words(stem);
      const pattern = inflated(parts);
      if (!overlong(stem, parts) && !pattern) continue;
      const namedPath = segments.slice(0, index + 1).join("/");
      if (!isFile && seenDirectories.has(namedPath)) continue;
      if (!isFile) seenDirectories.add(namedPath);
      const replacement = compact(parts, "path");
      findings.push(warning("CG318", namedPath, {file: relative, line: 1, column: 1},
        `The ${isFile ? "filename" : "directory"} segment ${stem} has ${stem.length} characters and ${parts.length} words${pattern ? `, including ${pattern}` : ""}. Long paths reduce discoverability and make imports harder to scan.`,
        `Consider ${replacement}${isFile ? path.extname(segment) : ""} as a shorter path if unambiguous. Update imports, entry points, documentation links and references. Preserve published file paths when compatibility matters.`, 0));
    }
    const reportName = (node: ts.Node, ident: ts.Identifier | ts.PrivateIdentifier | ts.StringLiteral): void => {
      const name = ident.text;
      const parts = words(name);
      const pattern = inflated(parts);
      const isLong = overlong(name, parts);
      const target = location(project.root, ident);
      const suggestion = `Consider ${compact(parts, "identifier")} if clear in context, or another concise domain-specific abbreviation. Rename references with the TypeScript symbol tools and preserve public API compatibility.`;
      if (isLong) findings.push(warning("CG316", name, target,
        `This ${category(node)} name has ${name.length} characters across ${parts.length} words. Its detail may belong in types or documentation rather than the identifier.`, suggestion, ident.getWidth(file)));
      if (pattern) findings.push(warning("CG317", name, target,
        `This ${category(node)} name contains ${pattern}; the stacked generic terms make the declaration harder to identify and distinguish.`, suggestion, ident.getWidth(file)));
    };
    const visit = (node: ts.Node): void => {
      const ident = declarationName(node);
      if (ident) reportName(node, ident);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return withoutIgnored(project.root, findings);
}
