#!/usr/bin/env node
import { loadProject } from "./project.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { noNestedIf } from "./guards/no-nested-if.ts";
import { typeReuse } from "./guards/type-reuse.ts";
import { functionQuality } from "./guards/function-quality.ts";
import { guards, type Finding, type GuardName } from "./model.ts";

type Format = "text" | "json" | "github";
type Options = { enabled: Set<GuardName>; project: string; format: Format; strict: boolean; includeTests: boolean; offline: boolean };

function checkGuard(value: string | undefined): GuardName {
  if (!guards.some(name => name === value)) usage();
  return value as GuardName;
}

function usage(): never {
  console.error("Usage: code-guards [all|no-nested-if|type-reuse|function-quality] [--disable <guard>] [--strict] [--project tsconfig.json] [--format text|json|github] [--include-tests] [--offline]");
  process.exit(2);
}

// Parse local CI flags explicitly: all guards are enabled unless opted out.
export function options(argv: string[]): Options {
  const enabled = new Set<GuardName>(guards);
  let project = "tsconfig.json";
  let format: Format = "text";
  let strict = false;
  let includeTests = false;
  let offline = false;
  let selected = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") { project = argv[++i] ?? usage(); continue; }
    if (arg === "--format") {
      const next = argv[++i];
      format = next === "text" || next === "json" || next === "github" ? next : usage();
      continue;
    }
    if (arg === "--disable") {
      const next = argv[++i];
      enabled.delete(checkGuard(next));
      continue;
    }
    if (arg === "--strict") { strict = true; continue; }
    if (arg === "--include-tests") { includeTests = true; continue; }
    if (arg === "--offline") { offline = true; continue; }
    if (!selected && arg === "all") { selected = true; continue; }
    if (!selected && guards.some(name => name === arg)) {
      enabled.clear();
      enabled.add(arg as GuardName);
      selected = true;
      continue;
    }
    usage();
  }
  return { enabled, project, format, strict, includeTests, offline };
}

function escapeAnnotation(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function render(findings: Finding[], format: Format): void {
  if (format === "json") { console.log(JSON.stringify(findings, null, 2)); return; }
  for (const finding of findings) {
    const { file, line, column } = finding.location;
    if (format === "github") {
      const level = finding.severity === "info" ? "notice" : "warning";
      console.log(`::${level} file=${escapeAnnotation(file)},line=${line},col=${column},title=${finding.code}::${escapeAnnotation(finding.message)}`);
      continue;
    }
    const related = finding.related ? `; also ${finding.related.file}:${finding.related.line}` : "";
    const score = finding.similarity === undefined ? "" : ` [${Math.round(finding.similarity * 100)}%]`;
    console.log(`${file}:${line}:${column} ${finding.severity} ${finding.code}${score}: ${finding.message}${related}`);
  }
  if (format === "text") console.log(`${findings.length} finding(s): ${findings.filter(f => f.severity === "warning").length} warning(s).`);
}

export async function run(argv: string[]): Promise<number> {
  try {
    const config = options(argv);
    if (config.offline) process.env.CODE_GUARDS_OFFLINE = "1";
    const project = loadProject(config.project);
    const findings = [
      ...(config.enabled.has("no-nested-if") ? noNestedIf(project) : []),
      ...(config.enabled.has("type-reuse") ? await typeReuse(project, config.includeTests) : []),
      ...(config.enabled.has("function-quality") ? await functionQuality(project, config.includeTests) : [])
    ];
    render(findings, config.format);
    return config.strict && findings.some(f => f.severity === "warning") ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

// Test imports must not invoke the CLI; symlinks created by npm are executable.
const entryPoint = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entryPoint === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
