import { withoutIgnored } from "../model.ts";
import ts from "typescript";
import path from "node:path";
import { location, type Finding } from "../model.ts";
import type { Project } from "../project.ts";
import { zeroShot, supportsReuse, semanticConcurrency, type SemanticScorer } from "../semantic.ts";
import { orderedConcurrentMap } from "../inference-scheduler.ts";

type Property = { name: string; fingerprint: string };
type Definition = {
  name: string;
  kind: "type" | "interface" | "class";
  node: ts.Node;
  type: ts.Type;
  genericSignature: string;
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
    return synonyms[token] ?? (synonyms[singular] ?? singular);
  }).filter(token => token !== "full" && token !== "address");
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(words(left));
  const b = new Set(words(right));
  const overlap = [...a].filter(token => b.has(token)).length;
  return overlap / Math.max(a.size, b.size, 1);
}

function primitiveFingerprint(type: ts.Type, checker: ts.TypeChecker): string | null {
  if (type.flags & ts.TypeFlags.EnumLiteral && type.symbol) return `enum:${checker.getFullyQualifiedName(type.symbol)}`;
  if (type.isStringLiteral()) return `string-literal:${JSON.stringify(type.value)}`;
  if (type.isNumberLiteral()) return `number-literal:${type.value}`;
  if (type.flags & ts.TypeFlags.BooleanLiteral) return `boolean-literal:${checker.typeToString(type)}`;
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
  return null;
}

function declarationOf(symbol: ts.Symbol): ts.Declaration | null {
  const declarations = symbol.declarations ?? [];
  return symbol.valueDeclaration ?? (declarations[0] ?? null);
}

function qualifiedTypeName(type: ts.Type, checker: ts.TypeChecker): string {
  const symbol = type.symbol ?? type.aliasSymbol ?? null;
  const declaration = symbol ? declarationOf(symbol) : null;
  return declaration ? checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType) : checker.typeToString(type);
}

function objectFingerprint(type: ts.Type, checker: ts.TypeChecker, active: Set<ts.Type>, depth: number): string {
  // Large structural types are too costly to expand here. For smaller ones,
  // resolve members at their declarations so aliases retain their context.
  const properties = checker.getPropertiesOfType(type);
  const symbol = type.symbol ?? null;
  if (depth > 0 && properties.length > 32) return `complex:${qualifiedTypeName(type, checker)}`;
  const members = properties.map(property => {
    const declaration = declarationOf(property);
    const memberType = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : null;
    const optional = property.flags & ts.SymbolFlags.Optional ? "?" : "";
    const modifiers = declaration && ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) ?? [] : [];
    const readonly = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ? "readonly " : "";
    return `${readonly}${property.name}${optional}:${memberType ? fingerprint(memberType, checker, active, depth + 1) : "unknown"}`;
  }).sort();
  const index = checker.getIndexInfosOfType(type).map(item =>
    `[${item.keyType.flags & ts.TypeFlags.NumberLike ? "number" : "string"}]:${fingerprint(item.type, checker, active, depth + 1)}`
  ).sort();
  const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map(signature => {
    const args = signature.getParameters().map(symbol => {
      const declaration = declarationOf(symbol);
      return declaration ? fingerprint(checker.getTypeOfSymbolAtLocation(symbol, declaration), checker, active, depth + 1) : "unknown";
    });
    return `(${args.join(",")}):${fingerprint(signature.getReturnType(), checker, active, depth + 1)}`;
  }).sort();
  if (members.length || index.length || calls.length) return `{${[...members, ...index, ...calls].join(";")}}`;
  const declaration = symbol ? declarationOf(symbol) : null;
  return declaration ? checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation) : checker.typeToString(type);
}

// Resolve shape, including optionality, literal discriminants and call signatures;
// cap recursion to keep pathological generic/recursive types bounded.
function fingerprint(type: ts.Type, checker: ts.TypeChecker, active = new Set<ts.Type>(), depth = 0): string {
  const symbol = type.aliasSymbol ?? (type.symbol ?? null);
  const declarations = symbol ? symbol.declarations ?? [] : [];
  const declaration = declarations[0] ?? null;
  const source = declaration ? declaration.getSourceFile().fileName : "";
  if (declaration && (source.includes("node_modules") || /(?:^|[\\/])lib\.[^\\/]+\.d\.ts$/.test(source))) {
    return `external:${checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation)}`;
  }
  if (depth >= 5 || active.has(type)) return `complex:${qualifiedTypeName(type, checker)}`;
  const primitive = primitiveFingerprint(type, checker);
  if (primitive !== null) return primitive;
  if (type.isUnionOrIntersection()) {
    const kind = type.isUnion() ? "union" : "intersection";
    return `${kind}(${type.types.map(item => fingerprint(item, checker, active, depth + 1)).sort().join("|")})`;
  }
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0] ?? null;
    return `array(${element ? fingerprint(element, checker, active, depth + 1) : "unknown"})`;
  }
  if (checker.isTupleType(type)) {
    return `tuple(${checker.getTypeArguments(type as ts.TypeReference).map(item => fingerprint(item, checker, active, depth + 1)).join(",")})`;
  }
  active.add(type);
  try {
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      const fallback = checker.getDefaultFromTypeParameter(type);
      const declaration = type.symbol ? declarationOf(type.symbol) : null;
      const owner = declaration?.parent ?? null;
      const parameters: readonly ts.TypeParameterDeclaration[] = owner && (ts.isInterfaceDeclaration(owner) || ts.isTypeAliasDeclaration(owner) || ts.isClassDeclaration(owner))
        ? owner.typeParameters ?? [] : [];
      const position = declaration && ts.isTypeParameterDeclaration(declaration) ? parameters.indexOf(declaration) : -1;
      const identity = position >= 0 ? String(position) : checker.typeToString(type);
      return `parameter:${identity}:${constraint ? fingerprint(constraint, checker, active, depth + 1) : "unconstrained"}:${fallback ? fingerprint(fallback, checker, active, depth + 1) : "no-default"}`;
    }
    const reference = (type.flags & ts.TypeFlags.Object) && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference);
    const args = reference ? checker.getTypeArguments(type as ts.TypeReference) : type.aliasTypeArguments ?? [];
    const parameters = args.map(argument => fingerprint(argument, checker, active, depth + 1));
    const shape = objectFingerprint(type, checker, active, depth);
    return parameters.length ? `generic(${parameters.join(",")}):${shape}` : shape;
  } finally { active.delete(type); }
}

function isRecordType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnionOrIntersection()) return type.types.every(item =>
    Boolean(item.flags & (ts.TypeFlags.Object | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) &&
    !checker.isArrayType(item) && !checker.isTupleType(item)
  );
  return Boolean(type.flags & ts.TypeFlags.Object) && !checker.isArrayType(type) && !checker.isTupleType(type);
}

// A named reference reuses an existing declaration, even when instantiated
// with different generic arguments. Inline object types remain independent.
function isNamedAlias(node: ts.TypeAliasDeclaration, checker: ts.TypeChecker): boolean {
  let target = node.type;
  while (ts.isParenthesizedTypeNode(target)) target = target.type;
  if (!ts.isTypeReferenceNode(target)) return false;
  const symbol = checker.getSymbolAtLocation(target.typeName);
  if (!symbol) return false;
  const canonical = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return Boolean(canonical.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.TypeAlias));
}

function isModuleAugmentationMember(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isModuleDeclaration(parent) && ts.isStringLiteral(parent.name) && ts.isExternalModule(parent.getSourceFile())) return true;
  }
  return false;
}

function getDefinitions(project: Project, includeTests: boolean): Definition[] {
  const definitions: Definition[] = [];
  const seen = new Set<ts.Symbol>();
  for (const file of project.files) {
    if (!includeTests && /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|\.(?:test|spec)\.[cm]?tsx?$/.test(file.fileName)) continue;
    const visit = (node: ts.Node): void => {
      const isDefinition = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node);
      if (!isDefinition) { ts.forEachChild(node, visit); return; }
      const kind = ts.isClassDeclaration(node) ? "class" : ts.isInterfaceDeclaration(node) ? "interface" : "type";
      const identifier = node.name ?? null;
      if (!identifier) { ts.forEachChild(node, visit); return; }

      const symbol = project.checker.getSymbolAtLocation(identifier);
      if (!symbol || seen.has(symbol)) { ts.forEachChild(node, visit); return; }
      // Prefer the original declaration over an augmentation when both occur
      // in the project, regardless of source file traversal order.
      if (isModuleAugmentationMember(node) && symbol.declarations?.some(declaration => !isModuleAugmentationMember(declaration))) {
        ts.forEachChild(node, visit); return;
      }
      seen.add(symbol);
      if (ts.isTypeAliasDeclaration(node) && isNamedAlias(node, project.checker)) {
        ts.forEachChild(node, visit); return;
      }
      const type = project.checker.getTypeAtLocation(identifier);
      if (!isRecordType(type, project.checker)) { ts.forEachChild(node, visit); return; }
      const properties = project.checker.getPropertiesOfType(type).map(property => {
        const declaration = declarationOf(property);
        return {
          name: property.name,
          fingerprint: declaration ? fingerprint(project.checker.getTypeOfSymbolAtLocation(property, declaration), project.checker) : "unknown"
        };
      });
      // Primitive aliases, utility aliases and one-field records are too noisy.
      if (properties.length >= 2) {
        const genericSignature = (node.typeParameters ?? []).map(parameter =>
          fingerprint(project.checker.getTypeAtLocation(parameter.name), project.checker)
        ).join(";");
        definitions.push({ name: identifier.text, node, kind, type, genericSignature, properties, fingerprint: fingerprint(type, project.checker) });
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
      const right = b.properties[index] ?? null;
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

function candidatesWithExactMatches(definitions: Definition[]): Set<string> {
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
  return candidates;
}

function declarationName(node: ts.Node): ts.Node {
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name ?? node;
  return node;
}

function reuseAdvice(a: Definition, b: Definition, exact: boolean): string {
  if (!exact) return `Compare fields in ${a.name} and ${b.name}. Extract a shared base interface only for genuinely shared responsibilities; leave domain-specific fields separate.`;
  const source = a.node.getSourceFile().fileName;
  const destination = b.node.getSourceFile().fileName;
  const relative = path.relative(path.dirname(destination), source).replace(/\\/g, "/").replace(/\.[cm]?tsx?$/, ".js");
  const module = relative.startsWith(".") ? relative : `./${relative}`;
  const declaration = a.node;
  const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) ?? [] : [];
  const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const prefix = exported ? "" : `Export ${a.name} from ${path.basename(source)} first. `;
  return `${prefix}Prefer importing the existing definition: import type { ${a.name} } from "${module}"; If callers require the ${b.name} name, expose an alias: export type ${b.name} = ${a.name}; Confirm both concepts should evolve together.`;
}

async function compareDefinitions(project: Project, a: Definition, b: Definition, score: SemanticScorer): Promise<Finding | null> {
  if (a.node.getSourceFile() === b.node.getSourceFile()) return null;
  const isClass = a.kind === "class" || b.kind === "class";
  const commonShape = a.fingerprint === b.fingerprint && a.genericSignature === b.genericSignature && !isClass;
  // Independent generic declarations have distinct formal parameter symbols.
  // Compare their position-normalised constraints and full structural shape;
  // do not claim exact generic equivalence from a bounded expansion alone.
  const generic = a.genericSignature.length > 0;
  const equivalent = generic
    ? !a.fingerprint.includes("complex:") && !a.genericSignature.includes("complex:")
    : project.checker.isTypeAssignableTo(a.type, b.type) && project.checker.isTypeAssignableTo(b.type, a.type);
  const exactMatch = commonShape && equivalent;
  const commonFields = fieldSimilarity(a, b, false);
  const semanticFields = fieldSimilarity(a, b, true);
  const nearMatch = commonFields >= 0.7 && !exactMatch && !isClass;
  // A similar name alone is not evidence that two types share a reusable contract.
  // Require matching field names and compatible types before asking the model.
  if (!exactMatch && !nearMatch && semanticFields < 0.65) return null;

  // Deterministic matches need no model inference; other candidates must pass
  // actual zero-shot entailment and contradiction checks before reporting.
  let confidence = 1;
  if (!exactMatch) {
    const premise = `Two TypeScript declarations are being reviewed for reuse. The first is named ${a.name} with fields ${a.properties.map(p => `${p.name} (${p.fingerprint})`).join(", ")}. The second is named ${b.name} with fields ${b.properties.map(p => `${p.name} (${p.fingerprint})`).join(", ")}.`;
    const verdict = await score({
      premise,
      same: "both declarations represent the same domain concept and may share a reusable type",
      different: "the declarations represent different domain concepts and should remain separate"
    });
    confidence = supportsReuse(verdict) ? verdict.sameConcept : 0;
  }
  if (confidence === 0) return null;

  const code = exactMatch ? "CG101" : nearMatch ? "CG102" : "CG103";
  const shared = b.properties.filter(property => a.properties.some(other => other.name === property.name && other.fingerprint === property.fingerprint));
  const fields = shared.slice(0, 8).map(property => property.name).join(", ");
  const fieldNote = shared.length > 8 ? `${fields}, plus ${shared.length - 8} more` : fields;
  const reason = exactMatch
    ? `${b.name} duplicates the complete resolved shape of ${a.name} (${b.properties.length} fields: ${b.properties.map(property => property.name).join(", ")}).`
    : `${b.name} and ${a.name} may overlap. ${shared.length} exactly matching field(s)${shared.length ? `: ${fieldNote}` : ""}; zero-shot confidence ${Math.round(confidence * 100)}%. ${isClass ? "Class runtime behaviour may still differ." : "This is not proof of equivalent domain meaning."}`;
  return {
    guard: "type-reuse", severity: "warning", code,
    message: exactMatch ? `Duplicate type definition: ${b.name} matches ${a.name}` : `Potential type overlap: ${b.name} and ${a.name}`,
    location: location(project.root, declarationName(b.node)),
    related: location(project.root, declarationName(a.node)),
    relatedSpan: a.name.length,
    span: b.name.length,
    subject: b.name,
    reason,
    suggestion: reuseAdvice(a, b, exactMatch),
    similarity: Math.round(confidence * 100) / 100
  };
}

export async function typeReuse(project: Project, includeTests = false, score: SemanticScorer = zeroShot): Promise<Finding[]> {
  const definitions = getDefinitions(project, includeTests);
  const candidatePairs = [...candidatesWithExactMatches(definitions)].sort();
  // Preserve the previous candidate order while allowing independent NLI
  // questions to execute concurrently. Each worker has one in-flight task.
  const results = await orderedConcurrentMap(candidatePairs, semanticConcurrency(), async pair => {
    const [first = -1, second = -1] = pair.split(":").map(Number);
    const a = definitions[first] ?? null;
    const b = definitions[second] ?? null;
    return a && b ? compareDefinitions(project, a, b, score) : null;
  });
  const findings = results.filter((finding): finding is Finding => finding !== null);
  return withoutIgnored(project.root, findings).sort((a, b) =>
    a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line || a.code.localeCompare(b.code)
  );
}
