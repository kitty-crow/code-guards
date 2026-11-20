#!/usr/bin/env bun
/** Run real Code Guards scans under an external, fixed wall-clock deadline. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { accelerationNames, parseAccelerationFlags } from "../src/acceleration.ts";
import { guards } from "../src/model.ts";
import type { ScanTelemetry } from "../src/engine.ts";

export type ThroughputOptions = {
  project: string;
  seconds: number;
  modes: string[];
  batchSize: number;
  concurrency: number;
  guard: string;
};

export function throughputOptions(argv: readonly string[]): ThroughputOptions {
  let project = "";
  let seconds = 60;
  let batchSize = 4;
  let concurrency = 4;
  let guard = "all";
  const modes: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (flag !== "--project" && flag !== "--seconds" && flag !== "--mode" &&
        flag !== "--batch-size" && flag !== "--concurrency" && flag !== "--guard") {
      throw new Error("Unknown argument: " + flag);
    }
    const value = argv[++i] ?? "";
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag);
    if (flag === "--project") project = resolve(value);
    if (flag === "--mode") modes.push(value);
    if (flag === "--guard") guard = value;
    if (flag === "--seconds") seconds = Number(value);
    if (flag === "--batch-size") batchSize = Number(value);
    if (flag === "--concurrency") concurrency = Number(value);
  }
  if (!project || !existsSync(project)) throw new Error("Supply --project with an existing TensorFlow tsconfig path.");
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("--seconds must be 1..3600.");
  if (!Number.isSafeInteger(batchSize) || batchSize < 2 || batchSize > 16) throw new Error("--batch-size must be 2..16.");
  if (!Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 16) {
    throw new Error("--concurrency must be 2..16.");
  }
  if (guard !== "all" && !guards.some(name => name === guard)) throw new Error("Unknown guard: " + guard);
  const selected = modes.length ? modes : ["none", "webgpu", "batch,webgpu"];
  for (const mode of selected) {
    const args = ["--accelerate", mode];
    if (mode.split(",").includes("batch")) args.push("--batch-size", String(batchSize));
    if (mode.split(",").includes("parallel")) args.push("--concurrency", String(concurrency));
    const parsed = parseAccelerationFlags(args);
    if (parsed.remaining.length || !accelerationNames(parsed.acceleration).length) {
      throw new Error("Invalid mode: " + mode);
    }
  }
  return { project, seconds, modes: selected, batchSize, concurrency, guard };
}

type ScanResult = {
  mode: string;
  secondsLimit: number;
  elapsedSeconds: number;
  timedOut: boolean;
  completed: boolean;
  exitCode: number | null;
  loadedFiles: number;
  enabledRules: number;
  stage: string;
  completedStages: number;
  totalStages: number;
  stageFindings: number;
  completedInferenceWindows: number;
  completedSemanticQuestions: number;
  cacheHits: number;
  provider: string;
  error: string | null;
};

const eventPrefix = "CG_BENCH_EVENT ";

function isTelemetry(value: unknown): value is ScanTelemetry {
  return typeof value === "object" && value !== null &&
    "type" in value && typeof value.type === "string";
}

function consumeEvent(result: ScanResult, event: ScanTelemetry): void {
  if (event.type === "project") {
    result.loadedFiles = event.files;
    result.enabledRules = event.rules;
  } else if (event.type === "stage-start") {
    result.stage = event.stage;
    result.totalStages = event.total;
  } else if (event.type === "stage-complete") {
    result.completedStages += 1;
    result.stageFindings += event.findings;
  } else if (event.type === "model-ready") {
    result.provider = event.device;
  } else if (event.type === "inference") {
    result.completedInferenceWindows += event.windows;
  } else if (event.type === "verdict") {
    result.completedSemanticQuestions += 1;
  } else if (event.type === "cache-hit") {
    result.completedSemanticQuestions += 1;
    result.cacheHits += 1;
  }
}

async function runMode(settings: ThroughputOptions, mode: string): Promise<ScanResult> {
  const result: ScanResult = {
    mode, secondsLimit: settings.seconds, elapsedSeconds: 0, timedOut: false,
    completed: false, exitCode: null, loadedFiles: 0, enabledRules: 0,
    stage: "starting", completedStages: 0, totalStages: 0, stageFindings: 0,
    completedInferenceWindows: 0, completedSemanticQuestions: 0,
    cacheHits: 0, provider: "not initialised", error: null
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = [
    "src/cli.ts", ...(settings.guard === "all" ? [] : [settings.guard]),
    "--project", settings.project, "--benchmark-telemetry",
    "--accelerate", mode,
    ...(mode.split(",").includes("batch") ? ["--batch-size", String(settings.batchSize)] : []),
    ...(mode.split(",").includes("parallel") ? ["--concurrency", String(settings.concurrency)] : [])
  ];
  const started = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"]
  });
  let partial = "";
  const diagnostics: string[] = [];

  const handleLine = (line: string): void => {
    if (line.startsWith(eventPrefix)) {
      try {
        const parsed: unknown = JSON.parse(line.slice(eventPrefix.length));
        if (isTelemetry(parsed)) consumeEvent(result, parsed);
      } catch {
        diagnostics.push("Malformed benchmark telemetry");
      }
      return;
    }
    const trimmed = line.trim();
    if (trimmed) {
      diagnostics.push(trimmed);
      if (diagnostics.length > 8) diagnostics.shift();
    }
  };
  const errorStream = child.stderr;
  if (!errorStream) throw new Error("Unable to capture benchmark telemetry from the child process.");
  errorStream.setEncoding("utf8");
  errorStream.on("data", (chunk: string) => {
    partial += chunk;
    let pos = partial.indexOf("\n");
    while (pos >= 0) {
      handleLine(partial.slice(0, pos).trimEnd());
      partial = partial.slice(pos + 1);
      pos = partial.indexOf("\n");
    }
  });
  const deadline = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      result.timedOut = true;
      child.kill("SIGKILL");
    }
  }, settings.seconds * 1000);
  try {
    const close = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => accept({ code, signal }));
    });
    result.exitCode = close.code;
    result.completed = !result.timedOut && close.code === 0;
    if (partial.trim()) handleLine(partial.trim());
    if (!result.timedOut && close.code !== 0) {
      result.error = diagnostics.at(-1) ?? ("Child exited with code " + String(close.code));
    }
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && !result.timedOut) child.kill("SIGKILL");
    result.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  }
  return result;
}

async function main(): Promise<void> {
  const settings = throughputOptions(process.argv.slice(2));
  const results: ScanResult[] = [];
  for (const mode of settings.modes) {
    console.error("[Code Guards] Running " + mode + " for up to " + settings.seconds + " seconds");
    const result = await runMode(settings, mode);
    results.push(result);
    console.error("[Code Guards] " + mode + ": " + result.completedInferenceWindows +
      " inference windows, " + result.completedStages + "/" + result.totalStages +
      " stages; " + (result.timedOut ? "deadline reached" : result.error ?? "scan completed"));
  }
  const summary = {
    project: settings.project,
    secondsPerMode: settings.seconds,
    guard: settings.guard,
    definitions: {
      loadedFiles: "TypeScript project files parsed and loaded, not files fully checked",
      completedStages: "Entire guard stages finished before the deadline",
      completedInferenceWindows: "Actual completed MobileBERT model inference windows",
      completedSemanticQuestions: "Completed semantic verdicts, including cache hits"
    },
    results
  };
  console.log(JSON.stringify(summary, null, 2));
  if (results.some(result => result.error)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
