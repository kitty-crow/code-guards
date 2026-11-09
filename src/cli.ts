#!/usr/bin/env node
import { analyse } from "./engine.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guards, type GuardName } from "./model.ts";
import { renderFindings, type Format, type ColourMode } from "./diagnostics.ts";

type Options = { enabled: Set<GuardName>; project: string; format: Format; colour: ColourMode; strict: boolean; includeTests: boolean; offline: boolean };

function checkGuard(value: string | undefined): GuardName {
  if (!guards.some(name => name === value)) usage();
  return value as GuardName;
}

function usage(): never {
  console.error("Usage: code-guards [all|guard-name] [--disable <guard>] [--strict] [--path directory|tsconfig|file] [--project tsconfig.json] [--format text|json|github] [--colour auto|always|never] [--include-tests] [--offline]");
  process.exit(2);
}

function readTarget(argv: string[], index: number, selected: boolean): string {
  if (selected) usage();
  const target = argv[index + 1] ?? usage();
  if (target.startsWith("--")) usage();
  return target;
}

// Parse local CI flags explicitly: all guards are enabled unless opted out.
export function options(argv: string[]): Options {
  const enabled = new Set<GuardName>(guards);
  let project = "tsconfig.json";
  let targetSelected = false;
  let format: Format = "text";
  let colour: ColourMode = "auto";
  let strict = false;
  let includeTests = false;
  let offline = false;
  let selected = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project" || arg === "--path") {
      project = readTarget(argv, i, targetSelected);
      i += 1;
      targetSelected = true;
      continue;
    }
    if (arg === "--format") {
      const next = argv[++i];
      format = next === "text" || next === "json" || next === "github" ? next : usage();
      continue;
    }
    if (arg === "--colour" || arg === "--color") {
      const next = argv[++i];
      colour = next === "auto" || next === "always" || next === "never" ? next : usage();
      continue;
    }
    if (arg === "--no-colour" || arg === "--no-color") { colour = "never"; continue; }
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
  return { enabled, project, format, colour, strict, includeTests, offline };
}

export async function run(argv: string[]): Promise<number> {
  try {
    const config = options(argv);
    if (config.offline) process.env.CODE_GUARDS_OFFLINE = "1";
    const { findings, root } = await analyse(config);
    console.log(renderFindings(findings, { format: config.format, colour: config.colour, root }));
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
