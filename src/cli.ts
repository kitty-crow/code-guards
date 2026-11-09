#!/usr/bin/env bun
import { loadProject } from "./project.ts";
import { noNestedIf } from "./guards/no-nested-if.ts";
import { typeReuse } from "./guards/type-reuse.ts";
import type { Finding } from "./model.ts";

type Guard = "all" | "no-nested-if" | "type-reuse";
type Format = "text" | "json" | "github";
type FailOn = "error" | "warning" | "never";

function usage(): never {
  console.error("Usage: code-guards [all|no-nested-if|type-reuse] [--project tsconfig.json] [--format text|json|github] [--fail-on error|warning|never] [--include-tests]");
  process.exit(2);
}

function options(argv: string[]): { guard: Guard; project: string; format: Format; failOn: FailOn; includeTests: boolean } {
  let guard: Guard = "all";
  let project = "tsconfig.json";
  let format: Format = "text";
  let failOn: FailOn = "error";
  let includeTests = false;
  let selected = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") { project = argv[++i] ?? usage(); continue; }
    if (arg === "--format") {
      const value = argv[++i];
      format = value === "text" || value === "json" || value === "github" ? value : usage();
      continue;
    }
    if (arg === "--fail-on") {
      const value = argv[++i];
      failOn = value === "error" || value === "warning" || value === "never" ? value : usage();
      continue;
    }
    if (arg === "--include-tests") { includeTests = true; continue; }
    if (!selected && (arg === "all" || arg === "no-nested-if" || arg === "type-reuse")) {
      guard = arg;
      selected = true;
      continue;
    }
    usage();
  }
  return { guard, project, format, failOn, includeTests };
}

function annotate(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function render(findings: Finding[], format: Format): void {
  if (format === "json") { console.log(JSON.stringify(findings, null, 2)); return; }
  for (const finding of findings) {
    const { file, line, column } = finding.location;
    if (format === "github") {
      const level = finding.severity === "info" ? "notice" : finding.severity;
      console.log(`::${level} file=${annotate(file)},line=${line},col=${column},title=${finding.code}::${annotate(finding.message)}`);
      continue;
    }
    const related = finding.related ? `; also ${finding.related.file}:${finding.related.line}` : "";
    const score = finding.similarity === undefined ? "" : ` [${Math.round(finding.similarity * 100)}%]`;
    console.log(`${file}:${line}:${column} ${finding.severity} ${finding.code}${score}: ${finding.message}${related}`);
  }
  if (format === "text") console.log(`${findings.length} finding(s): ${findings.filter(finding => finding.severity === "error").length} error(s), ${findings.filter(finding => finding.severity === "warning").length} warning(s).`);
}

try {
  const config = options(process.argv.slice(2));
  const project = loadProject(config.project);
  const findings = [
    ...(config.guard === "type-reuse" ? [] : noNestedIf(project)),
    ...(config.guard === "no-nested-if" ? [] : typeReuse(project, config.includeTests))
  ];
  render(findings, config.format);
  const failures = findings.some(finding =>
    config.failOn === "warning" ? finding.severity !== "info" : finding.severity === "error"
  );
  if (config.failOn !== "never" && failures) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
