import ts from "typescript";
import { location, type Finding } from "../model.ts";
import type { Project } from "../project.ts";

type Property = { name: string; fingerprint: string };
type Definition = {
  name: string;
  kind: "type" | "interface" | "class";
  node: ts.Node;
  fingerprint: string;
  properties: Property[];
};

const synonyms: Readonly<Record<string, string>> = {
  clients: "customer", client: "customer", customers: "customer",
  people: "person", persons: "person", contacts: "contact",
  fullname: "name", firstname: "name", surname: "name",
  emailaddress: "email", emails: "email", telephone: "phone",
  mobile: "phone", organisations: "organisation", organizations: "organisation",
  organization: "organisation"
};

function words(value: string): string[] {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const tokens = spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.map(token => {
    const singular = token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
    return synonyms[token] ?? synonyms[singular] ?? singular;
  }).filter(token => token !== "full" && token !== "address");
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(words(left));
  const b = new Set(words(right));
  const overlap = [...a].filter(token => b.has(token)).length;
  return overlap / Math.max(a.size, b.size, 1);
}

function fingerprint(type: ts.Type, checker: ts.TypeChecker, active = new Set<ts.Type>(), depth = 0): string {
  const symbol = type.aliasSymbol ?? type.symbol;
  const source = symbol?.declarations?.[0]?.getSourceFile().fileName ?? "";
  if (source.includes("node_modules") || /(?:^|[\\/])lib\.[^\\/]+\.d\.ts$/.test(source)) {
    return `external:${checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)}`;
  }
  if (depth >= 5) return `complex:${symbol?.getName() ?? type.flags}`;
  if (type.isUnionOrIntersection()) {
    const kind = type.isUnion() ? "union" : "intersection";
    return `${kind}(${type.types.map(item => fingerprint(item, checker, active, depth + 1)).sort().join("|")})`;
  }
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.flags & ts.TypeFlags.Null) return "null";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Any) return "any";
  if (type.flags & ts.TypeFlags.Unknown) return "unknown";
  if (type.flags & ts.TypeFlags.Never) return "never";
  if (type.flags & ts.TypeFlags.BigIntLike) return "bigint";
  if (type.flags & ts.TypeFlags.ESSymbolLike) return "symbol";
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0];
    return `array(${element ? fingerprint(element, checker, active, depth + 1) : "unknown"})`;
  }
  if (checker.isTupleType(type)) {
    return `tuple(${checker.getTypeArguments(type as ts.TypeReference).map(item => fingerprint(item, checker, active, depth + 1)).join(",")})`;
  }
  if (active.has(type)) return "recursive";
  active.add(type);
  try {
    const properties = checker.getPropertiesOfType(type);
    if (properties.length > 32) return `complex:${symbol?.getName() ?? type.flags}`;
    const members = properties.map(property => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      const memberType = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : undefined;
      const optional = property.flags & ts.SymbolFlags.Optional ? "?" : "";
      const readonly = declaration && ts.canHaveModifiers(declaration) &&
        ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ? "readonly " : "";
      return `${readonly}${property.name}${optional}:${memberType ? fingerprint(memberType, checker, active, depth + 1) : "unknown"}`;
    }).sort();
    const index = checker.getIndexInfosOfType(type).map(item =>
      `[${item.keyType.flags & ts.TypeFlags.NumberLike ? "number" : "string"}]:${fingerprint(item.type, checker, active, depth + 1)}`
    ).sort();
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map(signature => {
      const args = signature.getParameters().map(symbol => {
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        return declaration ? fingerprint(checker.getTypeOfSymbolAtLocation(symbol, declaration), checker, active, depth + 1) : "unknown";
      });
      return `(${args.join(",")}):${fingerprint(signature.getReturnType(), checker, active, depth + 1)}`;
    }).sort();
    if (members.length || index.length || calls.length) {
      return `{${[...members, ...index, ...calls].join(";")}}`;
    }
    return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  } finally {
    active.delete(type);
  }
}

function isRecordType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnionOrIntersection()) return type.types.every(item =>
    Boolean(item.flags & (ts.TypeFlags.Object | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) &&
    !checker.isArrayType(item) && !checker.isTupleType(item)
  );
  return Boolean(type.flags & ts.TypeFlags.Object) && !checker.isArrayType(type) && !checker.isTupleType(type);
}

function getDefinitions(project: Project, includeTests: boolean): Definition[] {
  const definitions: Definition[] = [];
  for (const file of project.files) {
    if (!includeTests && /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|\.(?:test|spec)\.[cm]?tsx?$/.test(file.fileName)) continue;
    const visit = (node: ts.Node): void => {
      const isDefinition = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node);
      if (!isDefinition) { ts.forEachChild(node, visit); return; }
      const kind = ts.isClassDeclaration(node) ? "class" : ts.isInterfaceDeclaration(node) ? "interface" : "type";
      const name = node.name?.text;
      if (!name) { ts.forEachChild(node, visit); return; }

      const type = project.checker.getTypeAtLocation(node.name);
      if (!isRecordType(type, project.checker)) { ts.forEachChild(node, visit); return; }
      const properties = project.checker.getPropertiesOfType(type).map(property => {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        return {
          name: property.name,
          fingerprint: declaration ? fingerprint(project.checker.getTypeOfSymbolAtLocation(property, declaration), project.checker) : "unknown"
        };
      });
      // Primitive aliases, utility aliases and one-field records are too noisy.
      if (properties.length >= 2) {
        definitions.push({ name, node, kind, properties, fingerprint: fingerprint(type, project.checker) });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return definitions;
}

function fieldSimilarity(a: Definition, b: Definition, semantic: boolean): number {
  const unmatched = new Set(b.properties.map((_, index) => index));
  let total = 0;
  for (const left of a.properties) {
    let bestIndex = -1;
    let best = 0;
    for (const index of unmatched) {
      const right = b.properties[index];
      if (!right || left.fingerprint !== right.fingerprint) continue;
      const score = semantic ? tokenSimilarity(left.name, right.name) : Number(left.name === right.name);
      if (score > best) {
        best = score;
        bestIndex = index;
      }
    }
    if (bestIndex !== -1) unmatched.delete(bestIndex);
    total += best;
  }
  return total / Math.max(a.properties.length, b.properties.length);
}

function candidatePairs(definitions: Definition[]): Set<string> {
  const index = new Map<string, number[]>();
  definitions.forEach((definition, i) => {
    const keys = new Set([
      ...words(definition.name).map(word => `name:${word}`),
      ...definition.properties.flatMap(property => words(property.name).map(word => `field:${word}`))
    ]);
    for (const key of keys) index.set(key, [...(index.get(key) ?? []), i]);
  });

  const pairs = new Set<string>();
  for (const indices of index.values()) {
    // Generic fields such as `id` or `name` occur in too many unrelated types.
    if (indices.length > 250) continue;
    indices.forEach((left, i) => {
      for (const right of indices.slice(i + 1)) pairs.add(`${Math.min(left, right)}:${Math.max(left, right)}`);
    });
  }
  return pairs;
}

export function typeReuse(project: Project, includeTests = false): Finding[] {
  const definitions = getDefinitions(project, includeTests);
  const candidates = candidatePairs(definitions);
  const exact = new Map<string, number[]>();
  definitions.forEach((definition, i) => {
    if (definition.kind === "class") return;
    exact.set(definition.fingerprint, [...(exact.get(definition.fingerprint) ?? []), i]);
  });
  for (const indices of exact.values()) {
    indices.forEach((left, i) => {
      for (const right of indices.slice(i + 1)) candidates.add(`${left}:${right}`);
    });
  }

  const findings: Finding[] = [];
  for (const pair of candidates) {
    const [first, second] = pair.split(":").map(Number);
    const a = definitions[first ?? -1];
    const b = definitions[second ?? -1];
    if (!a || !b) continue;
    if (a.node.getSourceFile() === b.node.getSourceFile()) continue;

    const isClass = a.kind === "class" || b.kind === "class";
    const matchingShape = a.fingerprint === b.fingerprint;
    const commonFields = fieldSimilarity(a, b, false);
    const semanticFields = fieldSimilarity(a, b, true);
    const semantics = tokenSimilarity(a.name, b.name) * 0.4 + semanticFields * 0.6;
    const exactMatch = matchingShape && !isClass;
    const nearMatch = commonFields >= 0.7 && !exactMatch && !isClass;
    if (!exactMatch && !nearMatch && semantics < 0.78) continue;

    const code = exactMatch ? "CG101" : nearMatch ? "CG102" : "CG103";
    const severity = exactMatch || nearMatch ? "warning" : "info";
    const score = exactMatch ? 1 : nearMatch ? commonFields : semantics;
    const qualification = isClass ? " Classes can have distinct runtime behaviour." : "";
    findings.push({
      guard: "type-reuse", severity, code,
      message: `Potential reuse: ${b.name} and ${a.name} (${exactMatch ? "identical structure" : nearMatch ? "overlapping fields" : "similar concepts"}). Review before consolidating.${qualification}`,
      location: location(project.root, b.node),
      related: location(project.root, a.node),
      similarity: Math.round(score * 100) / 100
    });
  }
  return findings.sort((a, b) =>
    a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line || a.code.localeCompare(b.code)
  );
}
