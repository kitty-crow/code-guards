#!/usr/bin/env bun
/** Run real Code Guards scans under an external, fixed wall-clock deadline. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { accelerationNames, parseAccelerationFlags } from "../src/acceleration.ts";
import { guards } from "../src/model.ts";
import type { ScanTelemetry } from "../src/engine.ts";
import type { ExpertMetrics } from "../src/experts.ts";
import type { JsonRecord } from "../src/json.ts";
import { parseRecord } from "../src/json.ts";

export type ThroughputOptions = {
  project: string;
  seconds: number;
  modes: string[];
  batchSize: number;
  concurrency: number;
  gpuIds: string | null;
  guard: string;
};

function modeArgs(settings: ThroughputOptions, mode: string): string[] {
  const features = mode.split(",");
  const parallel = features.includes("parallel");
  const gpu = features.some(feature => ["cuda", "dml", "webgpu"].includes(feature));
  return [
    "--accelerate", mode,
    ...(features.includes("batch") ? ["--batch-size", String(settings.batchSize)] : []),
    ...(parallel ? ["--concurrency", String(settings.concurrency)] : []),
    ...(settings.gpuIds && parallel && gpu ? ["--gpu-ids", settings.gpuIds] : [])
  ];
}

function readOptions(argv: readonly string[]): ThroughputOptions {
  const settings: ThroughputOptions = {
    project: "", seconds: 60, modes: [], batchSize: 4, concurrency: 4, gpuIds: null, guard: "all"
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1] ?? "";
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag);
    switch (flag) {
      case "--project": settings.project = resolve(value); break;
      case "--mode": settings.modes.push(value); break;
      case "--guard": settings.guard = value; break;
      case "--seconds": settings.seconds = Number(value); break;
      case "--batch-size": settings.batchSize = Number(value); break;
      case "--concurrency": settings.concurrency = Number(value); break;
      case "--gpu-ids": settings.gpuIds = value; break;
      default: throw new Error("Unknown argument: " + flag);
    }
  }
  return settings;
}

function validateOptions(settings: ThroughputOptions): void {
  if (!settings.project || !existsSync(settings.project)) throw new Error("Supply --project with an existing TypeScript tsconfig path.");
  if (!Number.isSafeInteger(settings.seconds) || settings.seconds < 1 || settings.seconds > 3600) throw new Error("--seconds must be 1..3600.");
  if (!Number.isSafeInteger(settings.batchSize) || settings.batchSize < 2 || settings.batchSize > 16) throw new Error("--batch-size must be 2..16.");
  if (!Number.isSafeInteger(settings.concurrency) || settings.concurrency < 2 || settings.concurrency > 16) throw new Error("--concurrency must be 2..16.");
  if (settings.guard !== "all" && !guards.some(name => name === settings.guard)) throw new Error("Unknown guard: " + settings.guard);
}

export function throughputOptions(argv: readonly string[]): ThroughputOptions {
  const settings = readOptions(argv);
  validateOptions(settings);
  if (!settings.modes.length) settings.modes = ["none", "webgpu", "batch,webgpu"];
  for (const mode of settings.modes) {
    const parsed = parseAccelerationFlags(modeArgs(settings, mode));
    if (parsed.remaining.length || !accelerationNames(parsed.acceleration).length) throw new Error("Invalid mode: " + mode);
  }
  return settings;
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
  completedInferenceCalls: number;
  crossQuestionBatches: number;
  maximumBatchSize: number;
  completedSemanticQuestions: number;
  cacheHits: number;
  experts: Record<string, {revision: string; device: string; metrics: ExpertMetrics}>;
  provider: string;
  gpuWindows: Record<string, number>;
  gpuProviderProof: Record<string, {
    gpuNodes: number; cpuNodes: number; gpuOps: string[];
    gpuTimeMs: number; cpuTimeMs: number;
  }>;
  error: string | null;
};

const eventPrefix = "CG_BENCH_EVENT ";

/** Prefer the primary exception over the footer of Bun's crash report. */
export function usefulBenchmarkError(lines: readonly string[]): string | null {
  const useful = lines.filter(line =>
    /(?:GPU \d+ worker|Traceback|Error:|error:|Exception:|panic:|EPIPE|WebGPU|ONNX Runtime|adapterIndex)/i.test(line) &&
    !line.startsWith("[Code Guards]") && !/^Bun v\d/i.test(line)
  );
  return useful.at(0) ?? (lines.find(line => !/^Bun v\d/i.test(line) &&
    !line.startsWith("[Code Guards]")) ?? null);
}

function decodeExpertMetrics(data: JsonRecord): ExpertMetrics {
  return {
    loads: data.number("loads"), batches: data.number("batches"),
    cacheHits: data.number("cacheHits"), persistentHits: data.number("persistentHits"),
    encodedInputs: data.number("encodedInputs"), loadMilliseconds: data.number("loadMilliseconds"),
    inferenceMilliseconds: data.number("inferenceMilliseconds"),
    sampledPeakRssBytes: data.number("sampledPeakRssBytes"), rssAfterDisposalBytes: data.number("rssAfterDisposalBytes")
  };
}

export function decodeEvent(line: string): ScanTelemetry {
  const data = parseRecord(line);
  const type = data.text("type");
  switch (type) {
    case "project": return { type, files: data.number("files"), rules: data.number("rules") };
    case "stage-start": return { type, stage: data.text("stage"), index: data.number("index"), total: data.number("total") };
    case "stage-complete": return { type, stage: data.text("stage"), index: data.number("index"), findings: data.number("findings") };
    case "model-ready": return { type, device: data.text("device") };
    case "inference": {
      const gpu = data.get("gpuId");
      const questions = data.get("questions");
      return { type, windows: data.number("windows"), gpuId: typeof gpu === "number" ? gpu : null,
        questions: typeof questions === "number" ? questions : 1 };
    }
    case "verdict": return { type, windows: data.number("windows") };
    case "provider-proof": return { type, gpuId: data.number("gpuId"), gpuNodes: data.number("gpuNodes"),
      cpuNodes: data.number("cpuNodes"), gpuOps: data.strings("gpuOps"),
      gpuTimeMs: data.number("gpuTimeMs"), cpuTimeMs: data.number("cpuTimeMs") };
    case "cache-hit": return { type };
    case "expert-complete": return {type, model: data.text("model"), revision: data.text("revision"), device: data.text("device"), metrics: decodeExpertMetrics(data.record("metrics"))};
    default: throw new Error("Invalid benchmark telemetry: " + type);
  }
}

function consumeEvent(result: ScanResult, event: ScanTelemetry): void {
  switch (event.type) {
    case "project":
      result.loadedFiles = event.files;
      result.enabledRules = event.rules;
      return;
    case "stage-start":
      result.stage = event.stage;
      result.totalStages = event.total;
      return;
    case "stage-complete":
      result.completedStages += 1;
      result.stageFindings += event.findings;
      return;
    case "model-ready":
      result.provider = event.device;
      return;
    case "inference":
      result.completedInferenceWindows += event.windows;
      result.completedInferenceCalls += 1;
      result.maximumBatchSize = Math.max(result.maximumBatchSize, event.windows);
      if (event.questions > 1) result.crossQuestionBatches += 1;
      if (event.gpuId !== null) {
        const key = String(event.gpuId);
        result.gpuWindows[key] = (result.gpuWindows[key] ?? 0) + event.windows;
      }
      return;
    case "verdict":
      result.completedSemanticQuestions += 1;
      return;
    case "provider-proof":
      result.gpuProviderProof[String(event.gpuId)] = {
        gpuNodes: event.gpuNodes, cpuNodes: event.cpuNodes, gpuOps: event.gpuOps,
        gpuTimeMs: event.gpuTimeMs, cpuTimeMs: event.cpuTimeMs
      };
      return;
    case "expert-complete":
      result.experts[event.model] = {revision: event.revision, device: event.device, metrics: event.metrics};
      return;
    case "cache-hit":
      result.completedSemanticQuestions += 1;
      result.cacheHits += 1;
      return;
  }
}

function killTree(pid: number): boolean {
  const killed = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true, stdio: "ignore", timeout: 2500
  });
  return (killed.error ?? null) === null && killed.status === 0;
}

function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    console.error("Could not terminate scan process group; stopping child directly.");
    return false;
  }
}

function emptyResult(settings: ThroughputOptions, mode: string): ScanResult {
  return {
    mode, secondsLimit: settings.seconds, elapsedSeconds: 0, timedOut: false,
    completed: false, exitCode: null, loadedFiles: 0, enabledRules: 0,
    stage: "starting", completedStages: 0, totalStages: 0, stageFindings: 0,
    completedInferenceWindows: 0, completedInferenceCalls: 0,
    crossQuestionBatches: 0, maximumBatchSize: 0, completedSemanticQuestions: 0,
    cacheHits: 0, experts: {}, provider: "not initialised", gpuWindows: {}, gpuProviderProof: {}, error: null
  };
}

function launchScan(settings: ThroughputOptions, mode: string): ChildProcess {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = [
    "src/cli.ts", ...(settings.guard === "all" ? [] : [settings.guard]),
    "--project", settings.project, "--benchmark-telemetry", ...modeArgs(settings, mode)
  ];
  return spawn(process.execPath, args, {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32"
  });
}

function captureTelemetry(child: ChildProcess, result: ScanResult): {
  diagnostics: string[]; flush: () => void
} {
  let partial = "";
  const diagnostics: string[] = [];
  const handleLine = (line: string): void => {
    if (line.startsWith(eventPrefix)) {
      try {
        consumeEvent(result, decodeEvent(line.slice(eventPrefix.length)));
      } catch {
        diagnostics.push("Malformed benchmark telemetry");
      }
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) return;
    diagnostics.push(trimmed);
    if (diagnostics.length > 64) diagnostics.shift();
  };
  const stream = child.stderr;
  if (!stream) throw new Error("Unable to capture benchmark telemetry from the child process.");
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    partial += chunk;
    let pos = partial.indexOf("\n");
    while (pos >= 0) {
      handleLine(partial.slice(0, pos).trimEnd());
      partial = partial.slice(pos + 1);
      pos = partial.indexOf("\n");
    }
  });
  return { diagnostics, flush: () => { if (partial.trim()) handleLine(partial.trim()); } };
}

function terminateScan(child: ChildProcess): void {
  const pid = child.pid ?? null;
  if (pid !== null && process.platform === "win32" && killTree(pid)) return;
  if (pid !== null && process.platform !== "win32" && killGroup(pid)) return;
  child.kill("SIGKILL");
}

function scanDeadline(child: ChildProcess, result: ScanResult): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      result.timedOut = true;
      terminateScan(child);
    }
  }, result.secondsLimit * 1000);
}

function waitForClose(child: ChildProcess): Promise<number | null> {
  return new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", code => accept(code));
  });
}

async function runMode(settings: ThroughputOptions, mode: string): Promise<ScanResult> {
  const result = emptyResult(settings, mode);
  const started = performance.now();
  const child = launchScan(settings, mode);
  const { diagnostics, flush } = captureTelemetry(child, result);
  const deadline = scanDeadline(child, result);
  try {
    result.exitCode = await waitForClose(child);
    result.completed = !result.timedOut && result.exitCode === 0;
    flush();
    if (!result.timedOut && result.exitCode !== 0) {
      result.error = usefulBenchmarkError(diagnostics) ?? ("Child exited with code " + String(result.exitCode));
    }
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && !result.timedOut) terminateScan(child);
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
      completedInferenceCalls: "Underlying MobileBERT pipeline invocations",
      gpuProviderProof: "First inference kernel counts and timing grouped by actual ONNX execution provider for each GPU adapter",
      crossQuestionBatches: "Invocations containing windows from more than one semantic question",
      maximumBatchSize: "Highest number of windows in a single inference invocation",
      completedSemanticQuestions: "Completed semantic verdicts, including cache hits"
    },
    results
  };
  console.log(JSON.stringify(summary, null, 2));
  if (results.some(result => result.error)) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
