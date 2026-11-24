#!/usr/bin/env node
import { analyse } from "./engine.ts";
import { estimateInference, formatInferencePreflight } from "./preflight.ts";
import { parseAccelerationFlags, type AccelerationConfig } from "./acceleration.ts";
import { configureSemanticAcceleration, relaySemanticWorkerEvent, useRemoteSemanticScorer } from "./semantic.ts";
import { createGpuWorkerPool, createNativeCpuWorkerPool } from "./inference-workers.ts";
import { synchroniseInferenceCache } from "./inference-cache-git.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { failed, guards, type GuardName } from "./model.ts";
import { renderFindings, type Format, type ColourMode } from "./diagnostics.ts";

type Options = { nativeCpu: boolean; enabled: Set<GuardName>; project: string; format: Format; colour: ColourMode; strict: boolean; includeTests: boolean; offline: boolean; progress: boolean; preflight: boolean; benchmarkTelemetry: boolean; acceleration: AccelerationConfig; inferenceCacheDir: string | null; cacheRemote: string | null; syncInferenceCache: boolean };

function checkGuard(value: string | null): GuardName {
  if (!guards.some(name => name === value)) usage();
  return value as GuardName;
}

function usage(): never {
  console.error("Usage: code-guards [all|guard-name] [--disable <guard>] [--strict] [--path directory|tsconfig|file] [--project tsconfig.json] [--format text|json|github] [--colour auto|always|never] [--include-tests] [--offline] [--progress] [--preflight] [--accelerate none|cache|batch|parallel|cuda|dml|webgpu] [--batch-size 2..16] [--concurrency 2..16] [--gpu-ids 0[,1...]] [--native-cpu] [--inference-cache-dir directory] [--cache-remote git-url] [--sync-inference-cache]");
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
  let nativeCpu = false;
  let progress = false;
  let benchmarkTelemetry = false;
  let preflight = false;
  let inferenceCacheDir: string | null = null;
  let cacheRemote: string | null = null;
  let syncInferenceCache = false;
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
    if (arg === "--inference-cache-dir") {
      inferenceCacheDir = readTarget(remaining, i, inferenceCacheDir !== null);
      i += 1;
      continue;
    }
    if (arg === "--cache-remote") {
      cacheRemote = readTarget(remaining, i, cacheRemote !== null);
      i += 1;
      continue;
    }
    if (arg === "--sync-inference-cache") { syncInferenceCache = true; continue; }
    if (arg === "--disable") {
      const next = remaining[++i] ?? usage();
      enabled.delete(checkGuard(next));
      continue;
    }
    if (arg === "--native-cpu") { nativeCpu = true; continue; }
    if (arg === "--strict") { strict = true; continue; }
    if (arg === "--include-tests") { includeTests = true; continue; }
    if (arg === "--offline") { offline = true; continue; }
    if (arg === "--progress") { progress = true; continue; }
    if (arg === "--benchmark-telemetry") { benchmarkTelemetry = true; continue; }
    if (arg === "--preflight") { preflight = true; continue; }
    if (!selected && arg === "all") { selected = true; continue; }
    if (!selected && guards.some(name => name === arg)) {
      enabled.clear();
      enabled.add(arg as GuardName);
      selected = true;
      continue;
    }
    usage();
  }
  if (syncInferenceCache && (!inferenceCacheDir || !cacheRemote)) {
    throw new Error("--sync-inference-cache requires --inference-cache-dir and --cache-remote.");
  }
  if (nativeCpu && (acceleration.gpuIds.length || acceleration.features.has("webgpu") ||
      acceleration.features.has("cuda") || acceleration.features.has("dml"))) {
    throw new Error("--native-cpu cannot be combined with GPU selection.");
  }
  if (inferenceCacheDir && !nativeCpu && (!acceleration.gpuIds.length || !acceleration.features.has("webgpu")) &&
      !preflight) {
    throw new Error("Persistent window cache requires --native-cpu or explicit native WebGPU GPU IDs.");
  }
  return { nativeCpu, enabled, project, format, colour, strict, includeTests, offline, progress, preflight,
    benchmarkTelemetry, acceleration, inferenceCacheDir, cacheRemote, syncInferenceCache };
}

export async function run(argv: string[]): Promise<number> {
  try {
    const config = options(argv);
    if (config.offline) process.env.CODE_GUARDS_OFFLINE = "1";
    if (config.preflight) {
      const result = await estimateInference(
        config, config.acceleration, null,
        config.progress ? message => console.error(message) : () => {}
      );
      console.log(config.format === "json"
        ? JSON.stringify(result, null, 2)
        : formatInferencePreflight(result));
      return 0;
    }
    if (config.inferenceCacheDir) {
      process.env.CODE_GUARDS_INFERENCE_CACHE_DIR = config.inferenceCacheDir;
    }
    if (config.syncInferenceCache) {
      synchroniseInferenceCache("pull", config.inferenceCacheDir ?? "", config.cacheRemote ?? "",
        message => console.error(message));
    }
    const restore = configureSemanticAcceleration(config.acceleration);
    let pool: ReturnType<typeof createGpuWorkerPool> | null = null;
    let restoreRemote: () => void = () => {};
    try {
      const gpuIds = config.acceleration.gpuIds;
      if (gpuIds.length || config.nativeCpu) {
        pool = config.nativeCpu
          ? createNativeCpuWorkerPool(config.acceleration, relaySemanticWorkerEvent)
          : createGpuWorkerPool(gpuIds, config.acceleration, relaySemanticWorkerEvent);
        const workerPool = pool;
        restoreRemote = useRemoteSemanticScorer(question => workerPool.score(question));
      }
      const { findings, root } = await analyse(
        config,
        config.progress ? message => console.error(message) : () => {},
        config.benchmarkTelemetry
          ? event => console.error("CG_BENCH_EVENT " + JSON.stringify(event))
          : () => {}
      );
      // Strict diagnostics must be reported as errors, not warning annotations.
      const reported = config.strict ? findings.map(finding =>
        finding.severity === "warning" ? {...finding, severity: "error" as const} : finding
      ) : findings;
      console.log(renderFindings(reported, { format: config.format, colour: config.colour, root }));
      return failed(findings, config.strict) ? 1 : 0;
    } finally {
      restoreRemote();
      if (pool) pool.close();
      restore();
      if (config.syncInferenceCache) {
        synchroniseInferenceCache("push", config.inferenceCacheDir ?? "", config.cacheRemote ?? "",
          message => console.error(message));
      }
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
