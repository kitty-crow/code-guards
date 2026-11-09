import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Project } from "../project.ts";
import type { Finding, Location } from "../model.ts";
import { supportsReuse, zeroShot, type SemanticScorer } from "../semantic.ts";

type Paragraph = { line: number; text: string };
type DocIssue = {
  code: string;
  file: string;
  line: number;
  title: string;
  subject: string;
  reason: string;
  suggestion: string;
  related?: Location;
};

const ignored = new Set([".git", "node_modules", "dist", "coverage", "examples", ".cache"]);
const marketing = /\b(?:seamlessly|cutting.edge|state.of.the.art|robust and scalable|powerful solution|revolutionary|effortlessly|leverage the power|unlock the potential|comprehensive suite|future.proof|game.changing)\b/i;
const promptLeak = /\b(?:you are an (?:expert|assistant)|as an ai language model|your task is to|do not hallucinate|act as a (?:senior|professional|helpful)|here is the prompt|follow these instructions)\b/i;
const vague = /\b(?:easy.to.use|highly flexible|powerful|robust|comprehensive|best.in.class|intuitive|efficient|enterprise.ready|production.ready|modern solution)\b/i;

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
  let releaseDepth: number | undefined;
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      releaseDepth = releaseHeading.test(heading[2] ?? "") ? level :
        releaseDepth !== undefined && level <= releaseDepth ? undefined : releaseDepth;
      continue;
    }
    if (releaseDepth !== undefined || /^\s*(?:>|[-*]\s+`|\d+\.\s+`)/.test(line)) continue;
    const prose = line.replace(/`[^`]*`/g, "");
    const match = narrative.map(rule => rule.exec(prose)).find(Boolean);
    if (!match) continue;
    const subject = line.trim();
    issue(findings, {code: "CG404", file, line: i + 1,
      title: "Change narrative presented as a feature",
      subject,
      reason: `The phrase \`${match[0]}\` describes a historical change rather than the current behaviour someone can use. That reads like a development summary, not product documentation.`,
      suggestion: "Describe the current behaviour directly with a working command, API, inputs/outputs or relevant limitation. Move the before/after explanation into a changelog or migration guide if history matters."});
  }
}


function read(root: string, file: string): string | undefined {
  try { return readFileSync(path.join(root, file), "utf8"); }
  catch { return undefined; }
}

function markdownFiles(root: string, relative = "", depth = 0): string[] {
  if (depth > 9) return [];
  let items;
  try { items = readdirSync(path.join(root, relative), { withFileTypes: true }); }
  catch { return []; }
  const files: string[] = [];
  for (const item of items) {
    if (ignored.has(item.name) || item.name.startsWith(".")) continue;
    const file = path.posix.join(relative, item.name);
    if (item.isDirectory()) { files.push(...markdownFiles(root, file, depth + 1)); continue; }
    if (item.isFile() && /\.mdx?$/i.test(item.name)) files.push(file);
  }
  return files.sort();
}

function paragraphs(lines: string[]): Paragraph[] {
  const result: Paragraph[] = [];
  let buffer: string[] = [];
  let start = 0;
  let fenced = false;
  const flush = (): void => {
    if (buffer.length) result.push({line: start, text: buffer.join(" ")});
    buffer = [];
  };
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { flush(); fenced = !fenced; return; }
    if (fenced || !line.trim() || /^\s*(?:#|\||[-*] |\d+\. )/.test(line)) { flush(); return; }
    if (!buffer.length) start = i + 1;
    buffer.push(line.trim());
  });
  flush();
  return result;
}

function similarity(a: string, b: string): number {
  const tokenize = (value: string): Set<string> => new Set(value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean));
  const left = tokenize(a);
  const right = tokenize(b);
  return [...left].filter(word => right.has(word)).length / Math.max(left.size, right.size, 1);
}

function moduleDocs(source: string): string[] {
  const module = source.replace(/^src\//, "").replace(/\.[cm]?tsx?$/, "");
  return [`docs/modules/${module}.md`, `src/${module}.md`];
}

function exportedNames(project: Project, file: ts.SourceFile): string[] {
  const symbol = project.checker.getSymbolAtLocation(file);
  if (!symbol) return [];
  return project.checker.getExportsOfModule(symbol).map(exported => exported.name).filter(name => name !== "default");
}

function lineFor(text: string, search: string): number {
  const position = text.indexOf(search);
  return position < 0 ? 1 : text.slice(0, position).split("\n").length;
}

function issue(findings: Finding[], item: DocIssue): void {
  findings.push({
    guard: "documentation", severity: "warning", code: item.code, message: item.title,
    location: {file: item.file, line: item.line, column: 1},
    subject: item.subject, span: Math.min(110, item.subject.length),
    reason: item.reason, suggestion: item.suggestion,
    ...(item.related ? {related: item.related} : {})
  });
}

function checkModuleCoverage(project: Project, files: Set<string>, findings: Finding[]): void {
  const index = read(project.root, "docs/index.md");
  const moduleFiles = project.files.filter(file => {
    const relative = path.relative(project.root, file.fileName).replace(/\\/g, "/");
    return relative.startsWith("src/") && ts.isExternalModule(file);
  });
  if (moduleFiles.length && !index) issue(findings, {
    code: "CG407", file: "docs/index.md", line: 1, title: "Documentation index is missing",
    subject: "docs/index.md", reason: `${moduleFiles.length} TypeScript modules need a navigable documentation entry point.`,
    suggestion: "Create docs/index.md with links to each module page, its responsibilities, relevant scripts and setup information. Link it from README.md."
  });
  for (const source of moduleFiles) {
    const sourcePath = path.relative(project.root, source.fileName).replace(/\\/g, "/");
    const candidates = moduleDocs(sourcePath);
    const doc = candidates.find(candidate => files.has(candidate));
    const exports = exportedNames(project, source);
    if (!doc) {
      issue(findings, {
        code: "CG408", file: sourcePath, line: 1, title: "Module has no documentation page",
        subject: sourcePath, reason: `This module exports ${exports.slice(0, 8).join(", ") || "a public module surface"} but has no matching documentation file.`,
        suggestion: `Create ${candidates[0]} describing its purpose, public exports, inputs, outputs, side effects and limitations. Add a link from docs/index.md.`
      });
      continue;
    }
    const content = read(project.root, doc) ?? "";
    checkImplementationClaim(project.root, source, doc, findings);
    if (content.replace(/```[\s\S]*?```/g, "").trim().length < 100) issue(findings, {
      code: "CG409", file: doc, line: 1, title: "Module documentation lacks practical detail",
      subject: doc, reason: `The document contains fewer than 100 characters of explanatory content outside code fences.`,
      suggestion: `Explain ${sourcePath}'s responsibilities, public API, usage and relevant limitations in plain language.`
    });
    const missing = exports.filter(name => !content.includes(name));
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
}

function checkCommands(file: string, content: string, scripts: Record<string, string>, findings: Finding[]): void {
  for (const [i, line] of content.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g)) {
      const command = match[0];
      const name = match[1] ?? "";
      if (scripts[name]) continue;
      issue(findings, {code: "CG406", file, line: i + 1, title: "Documentation references a missing package script", subject: command,
        reason: `package.json does not define '${name}', so this documented command cannot run as written.`,
        suggestion: `Correct the command to an existing script or implement '${name}' in package.json.`});
    }
  }
}

function checkImplementationClaim(root: string, source: ts.SourceFile, doc: string, findings: Finding[]): void {
  const content = read(root, doc) ?? "";
  if (!/\b(?:fully implemented|ready for use|implemented and tested|production.ready)\b/i.test(content)) return;
  const unfinished = source.text.match(/(?:TODO:?[ \t]*(?:implement|finish)|throw new Error\([\"'](?:not implemented|todo))/i);
  if (!unfinished) return;
  issue(findings, {code: "CG413", file: doc, line: lineFor(content, content.match(/fully implemented|ready for use|implemented and tested|production.ready/i)?.[0] ?? ""),
    title: "Documentation claims a feature is complete but source has a placeholder", subject: unfinished[0],
    reason: `A completion claim in ${doc} conflicts with an unfinished marker in ${source.fileName}. This requires manual verification rather than model certainty.`,
    suggestion: "Implement and test the missing behaviour, or rewrite the documentation to state what is currently unsupported."});
}

function checkLinks(root: string, file: string, content: string, findings: Finding[]): void {
  const withoutFences = content.replace(/```[\s\S]*?```/g, "");
  for (const match of withoutFences.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]?.split("#")[0] ?? "";
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const absolute = path.resolve(root, path.dirname(file), target);
    if (existsSync(absolute)) continue;
    issue(findings, {code: "CG412", file, line: lineFor(content, match[0]), title: "Broken local documentation link", subject: match[0],
      reason: `The linked path ${target} does not exist relative to ${path.dirname(file) || "."}.`,
      suggestion: "Correct the relative link or add the missing file. Prefer linking to actual implementation files or module docs."});
  }
}

async function checkProse(file: string, content: string, findings: Finding[], score: SemanticScorer): Promise<void> {
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
  const prose = paragraphs(lines);
  for (const [i, candidate] of prose.entries()) {
    for (const other of prose.slice(i + 1)) {
      if (candidate.text.length <= 75 || other.text.length < 75 || similarity(candidate.text, other.text) < 0.91) continue;
      issue(findings, {code: "CG403", file, line: other.line, title: "Documentation repeats earlier content", subject: other.text.slice(0, 110),
        reason: `This paragraph substantially repeats a paragraph at line ${candidate.line}.`, suggestion: "Consolidate the explanation once, then link to it from any other section.",
        related: {file, line: candidate.line, column: 1}});
    }
    // Zero-shot is a second stage: it must endorse a potentially vague paragraph.
    // Candidate filtering prevents constant model downloads for already specific docs.
    if (candidate.text.length < 50 || !vague.test(candidate.text) || marketing.test(candidate.text)) continue;
    const verdict = await score({
      premise: `Documentation paragraph: ${candidate.text}`,
      same: "this is vague promotional documentation without concrete user-facing information",
      different: "this paragraph contains precise implementation details, real usage instructions or testable limitations"
    });
    if (!supportsReuse(verdict, 0.75)) continue;
    issue(findings, {code: "CG410", file, line: candidate.line, title: "Zero-shot review suggests vague documentation", subject: candidate.text.slice(0, 115),
      reason: `The local NLI model favoured vague language over concrete usage (${Math.round(verdict.sameConcept * 100)}% entailment). This is a recommendation, not a factuality verdict.`,
      suggestion: "Replace the broad claim with an actual CLI invocation, API example, constraints, or a reproducible observation."});
  }
}

// Markdown is not part of TypeScript's source graph, so inspect the target
// repository directly when validating user-facing usage and module coverage.
export async function documentation(project: Project, score: SemanticScorer = zeroShot): Promise<Finding[]> {
  const findings: Finding[] = [];
  const root = project.root;
  const fileNames = markdownFiles(root);
  const files = new Set(fileNames);
  const packageText = read(root, "package.json");
  let scripts: Record<string, string> = {};
  if (packageText) {
    try { scripts = (JSON.parse(packageText) as {scripts?: Record<string, string>}).scripts ?? {}; }
    catch { throw new Error("package.json is invalid JSON; cannot verify documented commands"); }
  }
  if (!files.has("README.md")) issue(findings, {code: "CG400", file: "README.md", line: 1, title: "Repository lacks a README", subject: "README.md",
    reason: "The repository has no top-level entry point explaining how to install, run or maintain it.",
    suggestion: "Add a short README with purpose, prerequisites, working installation commands, example output, limitations and a link to docs/index.md."});
  checkModuleCoverage(project, files, findings);
  const readme = read(root, "README.md");
  if (readme && project.files.some(file => path.relative(root, file.fileName).startsWith("src/")) && !readme.includes("docs/index.md")) issue(findings, {
    code: "CG407", file: "README.md", line: 1, title: "README does not point developers to module docs", subject: "README.md",
    reason: "The codebase has source modules but the README does not link to the documentation index.",
    suggestion: "Add a link to docs/index.md near the setup or architecture section."
  });
  for (const file of fileNames) {
    const content = read(root, file);
    if (!content) continue;
    checkCommands(file, content, scripts, findings);
    checkLinks(root, file, content, findings);
    await checkProse(file, content, findings, score);
    if (path.basename(file).toLowerCase() !== "readme.md" || content.length < 180) continue;
    if (/\b(?:bun|npm|pnpm|yarn) (?:install|run|test|x)\b/.test(content)) continue;
    issue(findings, {code: "CG402", file, line: 1, title: "README has no runnable setup or usage command", subject: "README.md",
      reason: "There is no clear invocation showing how to install, run, build or test the project.",
      suggestion: "Include an actual command from package.json and explain what it does and what output to expect."});
  }
  return findings;
}
