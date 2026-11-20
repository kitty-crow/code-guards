#!/usr/bin/env node
import { analyse } from "./engine.ts";
import { parseAccelerationFlags, type AccelerationConfig } from "./acceleration.ts";
import { configureSemanticAcceleration, relaySemanticWorkerEvent, useRemoteSemanticScorer } from "./semantic.ts";
import { createGpuWorkerPool } from "./inference-workers.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { failed, guards, type GuardName } from "./model.ts";
import { renderFindings, type Format, type ColourMode } from "./diagnostics.ts";

type Options = { enabled: Set<GuardName>; project: string; format: Format; colour: ColourMode; strict: boolean; includeTests: boolean; offline: boolean; progress: boolean; benchmarkTelemetry: boolean; acceleration: AccelerationConfig };

function checkGuard(value: string | null): GuardName {
  if (!guards.some(name => name === value)) usage();
  return value as GuardName;
}

function usage(): never {
  console.error("Usage: code-guards [all|guard-name] [--disable <guard>] [--strict] [--path directory|tsconfig|file] [--project tsconfig.json] [--format text|json|github] [--colour auto|always|never] [--include-tests] [--offline] [--progress] [--accelerate none|cache|batch|parallel|cuda|webgpu] [--batch-size 2..16] [--concurrency 2..16] [--gpu-ids 0,1]");
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
  const { remaining, acceleration } = parseAccelerationFlags(argv);
  const enabled = new Set<GuardName>(guards);
  let project = "tsconfig.json";
  let targetSelected = false;
  let format: Format = "text";
  let colour: ColourMode = "auto";
  let strict = false;
  let includeTests = false;
  let offline = false;
  let progress = false;
  let benchmarkTelemetry = false;
  let selected = false;
  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i] ?? usage();
    if (arg === "--project" || arg === "--path") {
      project = readTarget(remaining, i, targetSelected);
      i += 1;
      targetSelected = true;
      continue;
    }
    if (arg === "--format") {
      const next = remaining[++i] ?? usage();
      format = next === "text" || next === "json" || next === "github" ? next : usage();
      continue;
    }
    if (arg === "--colour" || arg === "--color") {
      const next = remaining[++i] ?? usage();
      colour = next === "auto" || next === "always" || next === "never" ? next : usage();
      continue;
    }
    if (arg === "--no-colour" || arg === "--no-color") { colour = "never"; continue; }
    if (arg === "--disable") {
      const next = remaining[++i] ?? usage();
      enabled.delete(checkGuard(next));
      continue;
    }
    if (arg === "--strict") { strict = true; continue; }
    if (arg === "--include-tests") { includeTests = true; continue; }
    if (arg === "--offline") { offline = true; continue; }
    if (arg === "--progress") { progress = true; continue; }
    if (arg === "--benchmark-telemetry") { benchmarkTelemetry = true; continue; }
    if (!selected && arg === "all") { selected = true; continue; }
    if (!selected && guards.some(name => name === arg)) {
      enabled.clear();
      enabled.add(arg as GuardName);
      selected = true;
      continue;
    }
    usage();
  }
  return { enabled, project, format, colour, strict, includeTests, offline, progress, benchmarkTelemetry, acceleration };
}

export async function run(argv: string[]): Promise<number> {
  try {
    const config = options(argv);
    if (config.offline) process.env.CODE_GUARDS_OFFLINE = "1";
    const restore = configureSemanticAcceleration(config.acceleration);
    const gpuIds = config.acceleration.gpuIds;
    const pool = gpuIds
      ? createGpuWorkerPool(gpuIds, config.acceleration, relaySemanticWorkerEvent)
      : null;
    const restoreRemote = pool ? useRemoteSemanticScorer(question => pool.score(question)) : () => {};
    try {
      const { findings, root } = await analyse(
        config,
        config.progress ? message => console.error(message) : () => {},
        config.benchmarkTelemetry
          ? event => console.error("CG_BENCH_EVENT " + JSON.stringify(event))
          : () => {}
      );
      console.log(renderFindings(findings, { format: config.format, colour: config.colour, root }));
      return failed(findings, config.strict) ? 1 : 0;
    } finally {
      restoreRemote();
      pool?.close();
      restore();
    }
  } catch (error) {
    if (error == null) {
      console.error(error === null ? "null" : "undefined");
      return 2;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

// Test imports must not invoke the CLI; symlinks created by npm are executable.
const entry = process.argv[1] ?? "";
const entryPoint = entry ? realpathSync(entry) : "";
if (entryPoint === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
