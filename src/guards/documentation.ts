import { location, withoutIgnored } from "../model.ts";
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isVendoredPath, vendoredPaths, type Project } from "../project.ts";
import type { Finding, Location } from "../model.ts";
import { readScripts } from "../scripts.ts";
import { supportsReuse, zeroShot, comparisonQuestion, type SemanticScorer } from "../semantic.ts";
import type { ProseExpert } from "../experts.ts";

type Paragraph = { line: number; text: string; section: string; kind: "paragraph" | "heading" | "list" | "table" };
type DocIssue = {
  code: string;
  file: string;
  line: number;
  title: string;
  subject: string;
  reason: string;
  suggestion: string;
};
type RelatedDocIssue = DocIssue & { related: Location };

const ignored = new Set([".git", "node_modules", "dist", "coverage", "examples", ".cache", "vendor", "third_party", "third-party"]);
const marketing = /\b(?:seamlessly|cutting.edge|state.of.the.art|robust and scalable|powerful solution|revolutionary|effortlessly|leverage the power|unlock the potential|comprehensive suite|future.proof|game.changing)\b/i;
const promptLeak = /\b(?:you are an (?:expert|assistant)|as an ai language model|your task is to|do not hallucinate|act as a (?:senior|professional|helpful)|here is the prompt|follow these instructions)\b/i;

// A change log belongs in release notes; a feature description should describe current usage.
const releaseFile = /(?:^|\/)(?:changelog|history|release[-_]?notes?|migrations?)(?:\.[^/]+|\/)/i;
const releaseHeading = /\b(?:changelog|change log|release notes?|what(?:'|’)s new|migration(?: guide)?|upgrad(?:e|ing)|version history)\b/i;
const narrative = [
  /\b(?:this|the|our)\s+(?:library|package|tool|system|application|app|module|component|service|project|bot|feature)\s+(?:now|no longer)\s+\w+/i,
  /\b\w+\s+now\s+(?:supports|provides|performs|uses|handles|implements|offers|allows|includes|accepts|detects|runs|writes|does|returns|integrates|contains|works|operates)\b/i,
  /\b(?:we|i)\s+(?:have\s+)?(?:now\s+)?(?:added|introduced|implemented|updated|rewritten|refactored|replaced|migrated|improved|fixed|changed|enhanced|built|created|made|removed)\b/i,
  /\b(?:has|have)\s+(?:now\s+)?(?:been\s+)?(?:added|introduced|updated|rewritten|refactored|replaced|migrated|improved|fixed|changed|enhanced|removed)\b/i,
  /\b(?:previously|formerly|before this change|unlike before|in the previous version)\b.{0,120}\b(?:now|currently|instead|no longer)\b/i,
  /\b(?:instead of|rather than)\b.{0,120}\b(?:we now|now (?:uses|supports|does|performs)|have replaced|has replaced)\b/i,
  /\b(?:no longer)\b.{0,120}\b(?:instead|rather than|previously)\b/i
];

// Before-and-after descriptions belong in migration notes and release history.
// Exclude those sections so this rule targets misleading current-usage docs.
function checkNarrative(file: string, lines: string[], findings: Finding[]): void {
  if (releaseFile.test(file)) return;
  let releaseDepth: number | null = null;
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      releaseDepth = releaseHeading.test(heading[2] ?? "") ? level :
        releaseDepth !== null && level <= releaseDepth ? null : releaseDepth;
      continue;
    }
    if (releaseDepth !== null || /^\s*(?:>|[-*]\s+`|\d+\.\s+`)/.test(line)) continue;
    const prose = line.replace(/`[^`]*`/g, "");
    const match = narrative.map(rule => rule.exec(prose)).find(Boolean) ?? null;
    if (!match) continue;
    const subject = line.trim();
    issue(findings, {code: "CG404", file, line: i + 1,
      title: "Change narrative presented as a feature",
      subject,
      reason: `The phrase \`${match[0]}\` describes a historical change rather than the current behaviour someone can use. That reads like a development summary, not product documentation.`,
      suggestion: "Describe the current behaviour directly with a working command, API, inputs/outputs or relevant limitation. Move the before/after explanation into a changelog or migration guide if history matters."});
  }
}


function read(root: string, file: string): string | null {
  try { return readFileSync(path.join(root, file), "utf8"); }
  catch { return null; }
}

function markdownFiles(root: string, relative = "", depth = 0, submodules: ReadonlySet<string> = vendoredPaths(root)): string[] {
  if (depth > 9) return [];
  let items: Dirent[];
  try { items = readdirSync(path.join(root, relative), { withFileTypes: true }); }
  catch { return []; }
  const files: string[] = [];
  for (const item of items) {
    if (ignored.has(item.name) || item.name.startsWith(".")) continue;
    const file = path.posix.join(relative, item.name);
    if (isVendoredPath(root, path.join(root, file), submodules)) continue;
    if (item.isDirectory()) { files.push(...markdownFiles(root, file, depth + 1, submodules)); continue; }
    if (item.isFile() && /\.mdx?$/i.test(item.name)) files.push(file);
  }
  return files.sort();
}

// Flush pending prose before changing section or fence state, so an example or
// heading cannot inherit the previous section's editorial context.
function paragraphs(lines: string[]): Paragraph[] {
  const result: Paragraph[] = [];
  let buffer: string[] = [];
  let start = 0;
  let fence = "";
  let section = "Document introduction";
  const flush = (): void => {
    if (buffer.length) result.push({line: start, text: buffer.join(" "), section, kind: "paragraph"});
    buffer = [];
  };
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    const delimiter = /^(?:`{3,}|~{3,})/.exec(trimmed);
    if (delimiter && (!fence || delimiter[0].startsWith(fence))) {
      flush();
      fence = fence ? "" : delimiter[0];
      continue;
    }
    if (fence || !trimmed || /^\s{4}\S/.test(line) || trimmed.startsWith(">")) { flush(); continue; }
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flush();
      section = heading[1] ?? "Untitled section";
      const block: Paragraph = {line: i + 1, text: section, section, kind: "heading"};
      result.push(...[block].filter(item => /[.!?]$/.test(item.text)));
      continue;
    }
    const list = trimmed.match(/^(?:[-*+]|\d+\.)\s+(.+)$/);
    const table = trimmed.startsWith("|");
    if (list || table) {
      flush();
      const text = list ? list[1] ?? "" : trimmed;
      const plain = text.replace(/`[^`]*`/g, "").replace(/\[[^\]]+\]\([^)]+\)/g, "").replace(/[|:\s-]/g, "");
      const block: Paragraph = {line: i + 1, text, section, kind: list ? "list" : "table"};
      result.push(...[block].filter(() => plain.length > 0));
      continue;
    }
    if (!buffer.length) start = i + 1;
    buffer.push(trimmed);
  }
  flush();
  return result;
}

function similarity(a: string, b: string): number {
  const tokenize = (value: string): Set<string> => new Set(value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean));
  const left = tokenize(a);
  const right = tokenize(b);
  return [...left].filter(word => right.has(word)).length / Math.max(left.size, right.size, 1);
}

function moduleDocs(source: string): [string, string] {
  const module = source.replace(/^src\//, "").replace(/\.[cm]?tsx?$/, "");
  return [`docs/modules/${module}.md`, `src/${module}.md`];
}

function exportedNames(project: Project, file: ts.SourceFile): string[] {
  const symbol = project.checker.getSymbolAtLocation(file) ?? null;
  if (!symbol) return [];
  return project.checker.getExportsOfModule(symbol).map(exported => exported.name).filter(name => name !== "default");
}

function lineFor(text: string, search: string): number {
  const position = text.indexOf(search);
  return position < 0 ? 1 : text.slice(0, position).split("\n").length;
}

function issue(findings: Finding[], item: DocIssue | RelatedDocIssue): void {
  findings.push({
    guard: "documentation", severity: "warning", code: item.code, message: item.title,
    location: {file: item.file, line: item.line, column: 1},
    subject: item.subject, span: Math.min(110, item.subject.length),
    reason: item.reason, suggestion: item.suggestion,
    ...("related" in item ? {related: item.related} : {})
  });
}

type PublicSignature = {
  name: string;
  parameters: string[];
  minimum: number;
  maximum: number;
  result: string;
  location: Location;
};

// Only compare primitive type claims that the compiler can resolve without
// interpreting a potentially ambiguous imported alias in Markdown.
function primitiveType(type: ts.Type): string {
  const primitive = [
    [ts.TypeFlags.String, "string"], [ts.TypeFlags.Number, "number"],
    [ts.TypeFlags.Boolean, "boolean"], [ts.TypeFlags.Void, "void"],
    [ts.TypeFlags.BigInt, "bigint"], [ts.TypeFlags.Never, "never"],
    [ts.TypeFlags.Null, "null"]
  ] as const;
  const match = primitive.find(([flag]) => type.flags === flag) ?? null;
  return match ? match[1] : "";
}

// Use resolved overload declarations rather than implementation signatures:
// the implementation's wider union can accept arguments callers may not use.
function signatureEvidence(project: Project, source: ts.SourceFile): PublicSignature[] {
  const module = project.checker.getSymbolAtLocation(source) ?? null;
  if (!module) return [];
  const result: PublicSignature[] = [];
  for (const exported of project.checker.getExportsOfModule(module)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? project.checker.getAliasedSymbol(exported) : exported;
    const declaration = target.valueDeclaration ?? null;
    if (!declaration) continue;
    const type = project.checker.getTypeOfSymbolAtLocation(target, declaration);
    for (const signature of type.getCallSignatures()) {
      const signatureNode = signature.declaration ?? null;
      if (!signatureNode || !ts.isFunctionLike(signatureNode)) continue;
      const parameters = signatureNode.parameters;
      const minimum = parameters.filter(parameter => !(parameter.questionToken ?? null) && !(parameter.initializer ?? null) && !(parameter.dotDotDotToken ?? null) && parameter.name.getText() !== "this").length;
      const ordinary = parameters.filter(parameter => parameter.name.getText() !== "this");
      const maximum = ordinary.some(parameter => (parameter.dotDotDotToken ?? null) !== null) ? Infinity : ordinary.length;
      result.push({
        name: exported.name, minimum, maximum,
        parameters: ordinary.map(parameter => primitiveType(project.checker.getTypeAtLocation(parameter))),
        result: primitiveType(project.checker.getReturnTypeOfSignature(signature)),
        location: location(project.root, signatureNode)
      });
    }
  }
  return result;
}

function documentedSignature(text: string): ts.FunctionDeclaration | null {
  // A typed signature is an explicit API claim. Ordinary call examples,
  // pseudocode, and fenced implementation examples are not declarations.
  if (!/^(?:export\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(text)) return null;
  const parsed = ts.createSourceFile("documented-api.ts", text + ";", ts.ScriptTarget.Latest, true);
  const statement = parsed.statements[0] ?? null;
  if (!statement || !ts.isFunctionDeclaration(statement) || (statement.body ?? null) !== null || !(statement.type ?? null)) return null;
  return statement;
}

function contradictsSignature(claim: ts.FunctionDeclaration, actual: PublicSignature): boolean {
  const ordinary = claim.parameters.filter(parameter => parameter.name.getText() !== "this");
  const minimum = ordinary.filter(parameter => !(parameter.questionToken ?? null) && !(parameter.initializer ?? null) && !(parameter.dotDotDotToken ?? null)).length;
  const maximum = ordinary.some(parameter => (parameter.dotDotDotToken ?? null) !== null) ? Infinity : ordinary.length;
  if (minimum !== actual.minimum || maximum !== actual.maximum) return true;
  const result = claim.type ?? null;
  const primitives = /^(?:string|number|boolean|void|bigint|never|null)$/;
  const resultText = result ? result.getText() : "";
  if (actual.result && primitives.test(resultText) && resultText !== actual.result) return true;
  return ordinary.some((parameter, index) => {
    const type = parameter.type ?? null;
    const declared = type ? type.getText() : "";
    const implemented = actual.parameters[index] ?? "";
    return implemented.length > 0 && primitives.test(declared) && declared !== implemented;
  });
}

function checkDocumentedSignatures(project: Project, source: ts.SourceFile, doc: string, content: string, findings: Finding[]): void {
  const signatures = signatureEvidence(project, source);
  const names = new Set(exportedNames(project, source));
  for (const block of paragraphs(content.split(/\r?\n/))) {
    for (const match of block.text.matchAll(/\x60([^\x60]+)\x60/g)) {
      const claim = documentedSignature(match[1] ?? "");
      if (!claim) continue;
      const identifier = claim.name ?? null;
      const name = identifier ? identifier.text : "";
      if (!name) continue;
      const candidates = signatures.filter(item => item.name === name);
      const contradicted = candidates.length > 0 && candidates.every(candidate => contradictsSignature(claim, candidate));
      if (names.has(name) && !contradicted) continue;
      const first = candidates[0] ?? null;
      const base = {code: "CG413", file: doc, line: block.line, title: "Documented API signature conflicts with source",
        subject: match[0], reason: names.has(name)
          ? `No compiler-resolved overload of ${name} matches the documented required parameters, maximum arity and concrete primitive types.`
          : `The linked module does not export ${name}.`,
        suggestion: "Update the explicit signature to match an exported compiler-resolved overload, or implement the documented API."};
      issue(findings, first ? {...base, related: first.location} : base);
    }
  }
}

function checkModulePage(project: Project, source: ts.SourceFile, doc: string, index: string | null, findings: Finding[]): void {
  const sourcePath = path.relative(project.root, source.fileName).replace(/\\/g, "/");
  const exports = exportedNames(project, source);
  const content = read(project.root, doc) ?? "";
  checkImplementationClaim(project.root, source, doc, findings);
  checkDocumentedSignatures(project, source, doc, content, findings);
  if (content.replace(/```[\s\S]*?```/g, "").trim().length < 100) issue(findings, {
    code: "CG409", file: doc, line: 1, title: "Module documentation lacks practical detail",
    subject: doc, reason: `The document contains fewer than 100 characters of explanatory content outside code fences.`,
    suggestion: `Explain ${sourcePath}'s responsibilities, public API, usage and relevant limitations in plain language.`
  });
  const identifiers = new Set(content.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const missing = exports.filter(name => !identifiers.has(name));
  if (missing.length) issue(findings, {
    code: "CG409", file: doc, line: 1, title: "Documented module omits public exports",
    subject: doc, reason: `The module exports ${missing.join(", ")}, but its documentation does not mention these identifiers.`,
    suggestion: `Document how to use ${missing.slice(0, 5).join(", ")}, including expected inputs/outputs or when not to use them.`
  });
  if (index && !index.includes(doc.replace(/^docs\//, "")) && !index.includes(doc)) issue(findings, {
    code: "CG407", file: "docs/index.md", line: 1, title: "Module page is absent from documentation index",
    subject: doc, reason: `The module has a page at ${doc}, but docs/index.md does not link to it.`,
    suggestion: `Add a Markdown link to ${doc} in docs/index.md.`
  });
}

function sourceModules(project: Project): readonly ts.SourceFile[] {
  return project.files.filter(file => {
    const relative = path.relative(project.root, file.fileName).replace(/\\/g, "/");
    return relative.startsWith("src/") && ts.isExternalModule(file);
  });
}

// Module discovery handles absent pages separately: without a corresponding
// page there is no documentation claim or coverage evidence to validate.
function checkModuleCoverage(project: Project, files: Set<string>, findings: Finding[]): void {
  const index = read(project.root, "docs/index.md");
  const moduleFiles = sourceModules(project);
  if (moduleFiles.length && !index) issue(findings, {
    code: "CG407", file: "docs/index.md", line: 1, title: "Documentation index is missing",
    subject: "docs/index.md", reason: `${moduleFiles.length} TypeScript modules need a navigable documentation entry point.`,
    suggestion: "Create docs/index.md with links to each module page, its responsibilities, relevant scripts and setup information. Link it from README.md."
  });
  for (const source of moduleFiles) {
    const sourcePath = path.relative(project.root, source.fileName).replace(/\\/g, "/");
    const candidates = moduleDocs(sourcePath);
    const doc = candidates.find(candidate => files.has(candidate)) ?? null;
    const exports = exportedNames(project, source);
    if (!doc) {
      issue(findings, {
        code: "CG408", file: sourcePath, line: 1, title: "Module has no documentation page",
        subject: sourcePath, reason: `This module exports ${exports.slice(0, 8).join(", ") || "a public module surface"} but has no matching documentation file.`,
        suggestion: `Create ${candidates[0]} describing its purpose, public exports, inputs, outputs, side effects and limitations. Add a link from docs/index.md.`
      });
      continue;
    }
    checkModulePage(project, source, doc, index, findings);
  }
}

type ModuleContract = { name: string; source: Location; evidence: string };
type ContractPassage = Paragraph & {file: string};

// Inspect only declarations from the loaded project. External libraries may
// supply a type, but the scanner cannot establish their implementation contract.
function moduleContracts(project: Project, source: ts.SourceFile): ModuleContract[] {
  const symbol = project.checker.getSymbolAtLocation(source) ?? null;
  if (!symbol) return [];
  const contracts: ModuleContract[] = [];
  const eligible = new Set(project.files);
  for (const exported of project.checker.getExportsOfModule(symbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? project.checker.getAliasedSymbol(exported) : exported;
    const declarations = (target.declarations ?? []).filter(node => eligible.has(node.getSourceFile()));
    const first = declarations[0] ?? null;
    if (!first || exported.name === "default") continue;
    const value = target.valueDeclaration ?? null;
    const type = value ? project.checker.getTypeOfSymbolAtLocation(target, value) : project.checker.getDeclaredTypeOfSymbol(target);
    const typeText = project.checker.typeToString(type, first, ts.TypeFormatFlags.NoTruncation);
    const code = declarations.map(node => node.getText()).join("\n");
    contracts.push({name: exported.name, source: location(project.root, first),
      evidence: `Export ${exported.name}. Compiler type: ${typeText}. Source declarations:\n${code}`});
  }
  return contracts;
}

function linkedContractPages(project: Project, doc: string, allowed: Set<string>): string[] {
  const content = read(project.root, doc) ?? "";
  const links = [...content.replace(/\x60{3}[\s\S]*?\x60{3}/g, "").matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)];
  const targets = links.map(match => (match[1] ?? "").split("#", 1)[0] ?? "")
    .filter(target => target && !/^(?:[a-z]+:|\/|#)/i.test(target))
    .map(target => path.posix.normalize(path.posix.join(path.posix.dirname(doc), target)));
  return [...new Set([doc, ...targets.filter(target => allowed.has(target) && !releaseFile.test(target))])];
}

function contractPassages(project: Project, doc: string, allowed: Set<string>): ContractPassage[] {
  return linkedContractPages(project, doc, allowed).flatMap(file =>
    paragraphs((read(project.root, file) ?? "").split(/\r?\n/)).map(block => ({...block, file})));
}

function passageEvidence(passage: ContractPassage): string {
  return `${passage.file}:${passage.line} | ${passage.section}\n${passage.text}`;
}

function matchesContract(passage: ContractPassage, name: string): boolean {
  const identifiers = new Set((passage.section + " " + passage.text).match(/[A-Za-z_$][\w$]*/g) ?? []);
  return identifiers.has(name);
}

function reportUnresolvedContract(contract: ModuleContract, file: string, aspect: string): void {
  console.error(`[Code Guards] Unresolved ${aspect}: ${contract.name} in ${file}; source ${contract.source.file}:${contract.source.line}`);
}

async function reviewContractCoverage(contract: ModuleContract, passages: ContractPassage[], score: SemanticScorer, findings: Finding[]): Promise<void> {
  const first = passages[0] ?? null;
  if (!first) return;
  const docs = passages.map(passageEvidence).join("\n");
  const verdict = await score(comparisonQuestion({
    premise: `Public implementation:\n${contract.evidence}\nRelevant documentation:\n${docs}`,
    same: "the documentation of this exported contract is superficial or omits significant functionality, input, output, state changes, preconditions or limitations established by the source",
    different: "the documentation explains the significant public behaviour and contract without needing to narrate incidental implementation details"
  }, {name: "public implementation", evidence: contract.evidence}, {name: "relevant documentation", evidence: docs}));
  if (supportsReuse(verdict, 0.78)) {
    issue(findings, {code: "CG409", file: first.file, line: first.line,
      title: "Public contract lacks substantive documentation", subject: contract.name,
      reason: `The source contract for ${contract.name} and its retrieved documentation received ${Math.round(verdict.sameConcept * 100)}% support for incomplete coverage and ${Math.round(verdict.differentConcept * 100)}% opposition. Relevant passages: ${passages.map(item => item.file + ":" + item.line).join(", ")}.`,
      suggestion: "Explain the significant public behaviour, constraints and observable effects established by the related source declaration.", related: contract.source});
    return;
  }
  if (!supportsReuse({sameConcept: verdict.differentConcept, differentConcept: verdict.sameConcept}, 0.78)) reportUnresolvedContract(contract, first.file, "CG409 coverage");
}

async function reviewContractClaim(contract: ModuleContract, passage: ContractPassage, score: SemanticScorer, findings: Finding[]): Promise<void> {
  const docs = passageEvidence(passage);
  const verdict = await score(comparisonQuestion({
    premise: `Public implementation:\n${contract.evidence}\nDocumentation claim:\n${docs}`,
    same: "the documentation makes a concrete assertion about this exported contract that is contradicted by the actual implementation or compiler type",
    different: "the documentation is consistent with the supplied source or the supplied evidence cannot establish a contradiction"
  }, {name: "public implementation", evidence: contract.evidence}, {name: "documentation claim", evidence: docs}));
  if (supportsReuse(verdict, 0.78)) {
    issue(findings, {code: "CG413", file: passage.file, line: passage.line,
      title: "Documented contract may contradict implementation", subject: passage.text.slice(0, 110),
      reason: `The source-located claim about ${contract.name} received ${Math.round(verdict.sameConcept * 100)}% support for contradiction and ${Math.round(verdict.differentConcept * 100)}% opposition. Verify the exact claim against the related declaration; model support is not proof.`,
      suggestion: "Correct the specific behavioural claim or implement the stated contract, preserving the public API.", related: contract.source});
    return;
  }
  if (!supportsReuse({sameConcept: verdict.differentConcept, differentConcept: verdict.sameConcept}, 0.78)) reportUnresolvedContract(contract, passage.file, "CG413 claim");
}

async function reviewModuleContracts(project: Project, files: Set<string>, score: SemanticScorer, findings: Finding[]): Promise<void> {
  // Symbol retrieval traverses every scanned module and searches its own page
  // and directly linked in-scope pages. Missing retrieval is not proof of absence.
  for (const source of sourceModules(project)) {
    const relative = path.relative(project.root, source.fileName).replace(/\\/g, "/");
    const doc = moduleDocs(relative).find(candidate => files.has(candidate)) ?? null;
    if (!doc) continue;
    const passages = contractPassages(project, doc, files);
    for (const contract of moduleContracts(project, source)) {
      const relevant = passages.filter(passage => matchesContract(passage, contract.name));
      if (!relevant.length) reportUnresolvedContract(contract, doc, "CG409 retrieval");
      await reviewContractCoverage(contract, relevant, score, findings);
      for (const passage of relevant) await reviewContractClaim(contract, passage, score, findings);
    }
  }
}

/** Resolve the closest enclosing package, including independently vendored packages. */
function packageScripts(root: string, file: string): Record<string, string> {
  let directory = path.dirname(file);
  for (;;) {
    const manifest = path.join(directory, "package.json");
    const content = read(root, manifest);
    if (content !== null) return readScripts(content, manifest);
    if (directory === ".") return {};
    directory = path.dirname(directory);
  }
}

function checkCommands(file: string, content: string, scripts: Record<string, string>, findings: Finding[]): void {
  for (const [i, line] of content.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g)) {
      const command = match[0];
      const name = match[1] ?? "";
      if (scripts[name] ?? "") continue;
      issue(findings, {code: "CG406", file, line: i + 1, title: "Documentation references a missing package script", subject: command,
        reason: `package.json does not define '${name}', so this documented command cannot run as written.`,
        suggestion: `Correct the command to an existing script or implement '${name}' in package.json.`});
    }
  }
}

function checkImplementationClaim(root: string, source: ts.SourceFile, doc: string, findings: Finding[]): void {
  const content = read(root, doc) ?? "";
  if (!/\b(?:fully implemented|ready for use|implemented and tested|production.ready)\b/i.test(content)) return;
  const unfinished = /(?:TODO:?[ \t]*(?:implement|finish)|throw new Error\([\"'](?:not implemented|todo))/i.exec(source.text);
  if (!unfinished) return;
  const claim = /fully implemented|ready for use|implemented and tested|production.ready/i.exec(content);
  issue(findings, {code: "CG413", file: doc, line: lineFor(content, claim ? claim[0] : ""),
    title: "Documentation claims a feature is complete but source has a placeholder", subject: unfinished[0],
    reason: `A completion claim in ${doc} conflicts with an unfinished marker in ${source.fileName}. This requires manual verification rather than model certainty.`,
    suggestion: "Implement and test the missing behaviour, or rewrite the documentation to state what is currently unsupported."});
}

function checkLinks(root: string, file: string, content: string, findings: Finding[]): void {
  const withoutFences = content.replace(/```[\s\S]*?```/g, "");
  for (const match of withoutFences.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = (match[1] ?? "").split("#", 1)[0] ?? "";
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const absolute = path.resolve(root, path.dirname(file), target);
    if (existsSync(absolute)) continue;
    issue(findings, {code: "CG412", file, line: lineFor(content, match[0]), title: "Broken local documentation link", subject: match[0],
      reason: `The linked path ${target} does not exist relative to ${path.dirname(file) || "."}.`,
      suggestion: "Correct the relative link or add the missing file. Prefer linking to actual implementation files or module docs."});
  }
}

// Scope CG411 to README prose. Module API pages contain reference details that
// are not development handovers, even when they discuss how a guard works.
export const handoverQuestion = {
  same: "this paragraph is a developer-facing progress report, delivery note or self-justification about how work was completed, checked or left unfinished, not lasting user documentation",
  different: "this paragraph provides useful enduring information for readers about the software, such as behaviour, commands, interfaces, genuine limitations or concise attribution"
} as const;

// The shortlist is structural (Markdown prose), never a vocabulary heuristic.
// Require strong support and little contradictory evidence from the local model.
async function checkHandover(file: string, paragraph: Paragraph, findings: Finding[], score: SemanticScorer): Promise<void> {
  if (releaseFile.test(file) || path.posix.basename(file).toLowerCase() !== "readme.md") return;
  const verdict = await score({
    premise: `Documentation paragraph: ${paragraph.text}`,
    same: handoverQuestion.same,
    different: handoverQuestion.different
  });
  if (!supportsReuse(verdict, 0.85) || verdict.differentConcept > 0.35) return;
  issue(findings, {
    code: "CG411", file, line: paragraph.line,
    title: "Development handover prose in README",
    subject: paragraph.text.slice(0, 115),
    reason: `The local model favoured a temporary developer handover over stable documentation (${Math.round(verdict.sameConcept * 100)}% support versus ${Math.round(verdict.differentConcept * 100)}% opposing evidence). A README should explain current usage, behaviour and lasting constraints rather than narrate a coding session.`,
    suggestion: "Replace delivery and development-session narration with current behaviour, runnable instructions or lasting limitations. Keep historical implementation notes in a changelog."
  });
}

// Review the phrasing of individual sentences, not just their subject matter.
// Structural punctuation identifies candidates; no lexical triggers or examples
// are used to decide which sentences are problematic.
export const styleQuestion = {
  same: "the highlighted sentence is formulaic or overexplained technical prose, using needless clarification, self-conscious reassurance or an artificial explanatory cadence",
  different: "the wording of the highlighted sentence is direct and concise, without redundant explanations or mechanical transitions"
} as const;

export const informationQuestion = {
  same: "the highlighted sentence states concrete useful information, such as a software behaviour, specific data representation, API limitation, instruction, constraint or meaningful context",
  different: "the highlighted sentence is verbal padding, restates information already supplied by its context, or conveys no concrete information for the reader"
} as const;

function sentencesIn(paragraph: Paragraph): string[] {
  const sentences = paragraph.text.split(/(?<=[.!?])(?:[*_`"'’”)\]]{0,4})\s+(?=[`*_(\[]?[A-Z])/u);
  return sentences.flatMap(sentence => {
    const trimmed = sentence.trim();
    const clauses = trimmed.split(/;\s+(?=\S)/u).map(part => part.trim());
    // Dependent alternatives must retain their preceding condition. Reviewing
    // the fragment alone would turn an instruction into apparent padding.
    return [trimmed, ...clauses.slice(1).filter(part => !/^(?:otherwise|else|then)\b/i.test(part))];
  }).filter(Boolean);
}

function traceStyle(file: string, line: number, excerpt: string, score: {sameConcept: number; differentConcept: number}): void {
  if ((process.env.CODE_GUARDS_SEMANTIC_TRACE ?? "") !== "1") return;
  console.error(JSON.stringify({guard: "CG411", file, line, support: score.sameConcept, opposition: score.differentConcept, excerpt}));
}

async function checkStyle(file: string, paragraph: Paragraph, findings: Finding[], score: SemanticScorer): Promise<void> {
  if (releaseFile.test(file)) return;
  for (const sentence of sentencesIn(paragraph)) {
    const premise = `Section: ${paragraph.section}\nMarkdown role: ${paragraph.kind}\nDocumentation paragraph: ${paragraph.text}\nSentence to review: ${sentence}`;
    const verdict = await score({premise, ...styleQuestion});
    traceStyle(file, paragraph.line, sentence, verdict);
    if (!supportsReuse(verdict, 0.81) || verdict.differentConcept > 0.35) continue;
    // Style and information value answer different questions. Investigate
    // the actual contribution before treating a writing pattern as a defect.
    const information = await score({premise, ...informationQuestion});
    if (supportsReuse(information, 0.75)) continue;
    if (!supportsReuse({sameConcept: information.differentConcept, differentConcept: information.sameConcept}, 0.75)) {
      console.error(`[Code Guards] Unresolved CG411 information value at ${file}:${paragraph.line}: ${sentence}`);
      continue;
    }
    issue(findings, {
      code: "CG411", file, line: paragraph.line,
      title: "Formulaic or unnecessary wording in documentation",
      subject: sentence.slice(0, 115),
      reason: `Style review found mechanical or padded wording (${Math.round(verdict.sameConcept * 100)}% support). A separate information-value assessment supported unnecessary or redundant content (${Math.round(information.differentConcept * 100)}% support versus ${Math.round(information.sameConcept * 100)}% support for useful information).`,
      suggestion: "Avoid prompt-like wording in README and documentation. State relevant facts directly, remove redundant clarification and defensive assurances, and keep necessary technical detail."
    });
  }
}

// A README can have perfectly accurate paragraphs yet read like a development
// report as a whole. Judge the opening together, so zero-shot inference can
// evaluate the balance of project provenance and current user value.
async function checkReadmeIntroduction(file: string, prose: Paragraph[], findings: Finding[], score: SemanticScorer): Promise<void> {
  if (path.posix.basename(file).toLowerCase() !== "readme.md") return;
  const introduction = prose.slice(0, 3);
  if (introduction.length < 3) return;

  // Compare reader value with author-centred narration, paragraph by paragraph.
  // Do not look for project names, phrases or words from any example README.
  const history: Paragraph[] = [];
  for (const paragraph of introduction) {
    const verdict = await score({
      premise: `README introduction paragraph: ${paragraph.text}`,
      same: "this paragraph spends its attention on how the author produced, adapted or justified the implementation instead of giving readers a useful account of the software itself",
      different: "this paragraph concisely documents what readers need to know about the current software, including its purpose, use, behaviour, essential attribution or real operating constraints"
    });
    if (!supportsReuse(verdict, 0.75) || verdict.differentConcept > 0.55) continue;
    history.push(paragraph);
  }

  if (history.length < 2) return;
  const first = history[0] ?? null;
  if (!first) return;
  const lines = history.map(item => item.line).join(", ");
  issue(findings, {
    code: "CG411", file, line: first.line,
    title: "README introduction prioritises development history over usage",
    subject: first.text.slice(0, 115),
    reason: `Zero-shot NLP classified ${history.length} of the first ${introduction.length} introduction paragraphs as primarily development-history narration (lines ${lines}). This distracts from what readers can do with the current software; genuine technical details elsewhere in the introduction do not cancel that imbalance.`,
    suggestion: "Introduce the current purpose, key behaviour and first working command before detailed historical context. Keep essential attribution brief and move implementation history into development or release documentation."
  });
}

async function checkSemanticRedundancy(file: string, prose: Paragraph[], findings: Finding[], score: SemanticScorer, expert: ProseExpert): Promise<void> {
  const retrieval = await expert.rank(prose.map(paragraph => ({
    location: {file, line: paragraph.line, column: 1}, text: paragraph.text
  })));
  for (const passage of retrieval.unresolved) {
    console.error(`[Code Guards] Prose retrieval could not encode the complete paragraph at ${passage.location.file}:${passage.location.line}; lexical redundancy checks still apply.`);
  }
  for (const match of retrieval.matches) {
    if (findings.some(item => item.code === "CG403" && item.location.file === file && item.location.line === match.later.location.line)) continue;
    const verdict = await score(comparisonQuestion({
      premise: `Earlier paragraph: ${match.earlier.text}\nLater paragraph: ${match.later.text}`,
      same: "the later paragraph needlessly repeats the same information as the earlier paragraph without adding useful details",
      different: "the later paragraph adds distinct information or serves a useful summary, reminder, example or different context"
    }, {name: `earlier paragraph at line ${match.earlier.location.line}`, evidence: match.earlier.text},
    {name: `later paragraph at line ${match.later.location.line}`, evidence: match.later.text}));
    if (!supportsReuse(verdict, 0.81) || verdict.differentConcept > 0.35) continue;
    issue(findings, {code: "CG403", file, line: match.later.location.line,
      title: "Semantically repeated documentation", subject: match.later.text.slice(0, 110),
      reason: `Prose retrieval linked this paragraph to line ${match.earlier.location.line}; NLI favoured redundant information over a distinct purpose (${Math.round(verdict.sameConcept * 100)}% support, ${Math.round(verdict.differentConcept * 100)}% opposition).`,
      suggestion: "Keep the distinct technical details and consolidate only repeated information.",
      related: match.earlier.location});
  }
}

export const vagueQuestion = {
  same: "this paragraph makes broad promotional or vague claims without concrete user-facing information about the software",
  different: "this paragraph supplies useful technical context, precise implementation details, real usage instructions, examples or testable limitations"
} as const;

async function checkVague(file: string, candidate: Paragraph, findings: Finding[], score: SemanticScorer): Promise<void> {
  const premise = `Documentation paragraph: ${candidate.text}\nSection: ${candidate.section}`;
  const verdict = await score({premise, ...vagueQuestion});
  if (!supportsReuse(verdict, 0.75)) return;
  const information = await score({premise: `${premise}\nSentence to review: ${candidate.text}`, ...informationQuestion});
  if (supportsReuse(information, 0.75)) return;
  if (!supportsReuse({sameConcept: information.differentConcept, differentConcept: information.sameConcept}, 0.75)) {
    console.error(`[Code Guards] Unresolved CG410 information value at ${file}:${candidate.line}: ${candidate.text}`);
    return;
  }
  issue(findings, {code: "CG410", file, line: candidate.line, title: "Zero-shot review suggests vague documentation", subject: candidate.text.slice(0, 115),
    reason: `The broad-claim assessment received ${Math.round(verdict.sameConcept * 100)}% support. A separate information assessment supported missing concrete content (${Math.round(information.differentConcept * 100)}% support versus ${Math.round(information.sameConcept * 100)}% for useful information). This is not a factuality verdict.`,
    suggestion: "Replace the broad claim with an actual CLI invocation, API example, constraints, or a reproducible observation."});
}

// Keep structural checks separate from semantic judgements: a concrete fact
// can use formulaic wording, and lexical duplication does not require inference.
async function checkProse(file: string, content: string, findings: Finding[], score: SemanticScorer, expert: ProseExpert | null): Promise<void> {
  const lines = content.split(/\r?\n/);
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (marketing.test(line)) issue(findings, {code: "CG401", file, line: i + 1, title: "Unverifiable marketing claim", subject: line.trim(),
      reason: "The sentence uses promotional adjectives without a concrete feature, condition or measurable outcome.", suggestion: "State the behaviour, CLI command, input, output or limitation that a developer can verify."});
    if (promptLeak.test(line)) issue(findings, {code: "CG405", file, line: i + 1, title: "Prompt-style instructions in user documentation", subject: line.trim(),
      reason: "The sentence addresses an AI agent rather than someone trying to use or maintain this project.", suggestion: "Describe what the software does and how to use it, not instructions for generating a README."});
  }
  checkNarrative(file, lines, findings);
  const blocks = paragraphs(lines);
  const prose = blocks.filter(block => block.kind === "paragraph");
  await checkReadmeIntroduction(file, prose, findings, score);
  for (const [i, candidate] of prose.entries()) {
    const priorFindings = findings.length;
    await checkHandover(file, candidate, findings, score);
    if (!findings.slice(priorFindings).some(item => item.code === "CG411")) {
      await checkStyle(file, candidate, findings, score);
    }
    for (const other of prose.slice(i + 1)) {
      if (candidate.text.length <= 75 || other.text.length < 75 || similarity(candidate.text, other.text) < 0.91) continue;
      issue(findings, {code: "CG403", file, line: other.line, title: "Documentation repeats earlier content", subject: other.text.slice(0, 110),
        reason: `This paragraph substantially repeats a paragraph at line ${candidate.line}.`, suggestion: "Consolidate the explanation once, then link to it from any other section.",
        related: {file, line: candidate.line, column: 1}});
    }
    await checkVague(file, candidate, findings, score);
  }
  for (const block of blocks.filter(item => item.kind !== "paragraph")) await checkStyle(file, block, findings, score);
  if (expert) await checkSemanticRedundancy(file, prose, findings, score, expert);
}

// Markdown is not part of TypeScript's source graph, so inspect the target
// repository directly when validating user-facing usage and module coverage.
export async function documentation(project: Project, score: SemanticScorer = zeroShot, expert: ProseExpert | null = null,
  verifyContracts = (process.env.CODE_GUARDS_EXPERIMENTAL_CONTRACTS ?? "") === "1"): Promise<Finding[]> {
  const findings: Finding[] = [];
  const root = project.root;
  const fileNames = markdownFiles(root);
  const files = new Set(fileNames);
  if (!files.has("README.md")) issue(findings, {code: "CG400", file: "README.md", line: 1, title: "Repository lacks a README", subject: "README.md",
    reason: "The repository has no top-level entry point explaining how to install, run or maintain it.",
    suggestion: "Add a short README with purpose, prerequisites, working installation commands, example output, limitations and a link to docs/index.md."});
  checkModuleCoverage(project, files, findings);
  if (verifyContracts) await reviewModuleContracts(project, files, score, findings);
  const readme = read(root, "README.md");
  if (readme && project.files.some(file => path.relative(root, file.fileName).startsWith("src/")) && !readme.includes("docs/index.md")) issue(findings, {
    code: "CG407", file: "README.md", line: 1, title: "README does not point developers to module docs", subject: "README.md",
    reason: "The codebase has source modules but the README does not link to the documentation index.",
    suggestion: "Add a link to docs/index.md near the setup or architecture section."
  });
  for (const file of fileNames) {
    const content = read(root, file);
    if (!content) continue;
    checkCommands(file, content, packageScripts(root, file), findings);
    checkLinks(root, file, content, findings);
    await checkProse(file, content, findings, score, expert);
    if (path.basename(file).toLowerCase() !== "readme.md" || content.length < 180) continue;
    if (/\b(?:bun|npm|pnpm|yarn) (?:install|run|test|x)\b/.test(content)) continue;
    issue(findings, {code: "CG402", file, line: 1, title: "README has no runnable setup or usage command", subject: "README.md",
      reason: "There is no clear invocation showing how to install, run, build or test the project.",
      suggestion: "Include an actual command from package.json and explain what it does and what output to expect."});
  }
  return withoutIgnored(project.root, findings);
}
