#!/usr/bin/env bun
/** Run real Code Guards scans under an external, fixed wall-clock deadline. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { accelerationNames, parseAccelerationFlags } from "../src/acceleration.ts";
import { guards } from "../src/model.ts";
import type { ScanTelemetry } from "../src/engine.ts";
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

export function throughputOptions(argv: readonly string[]): ThroughputOptions {
  let project = "";
  let seconds = 60;
  let batchSize = 4;
  let concurrency = 4;
  let gpuIds: string | null = null;
  let guard = "all";
  const modes: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (flag !== "--project" && flag !== "--seconds" && flag !== "--mode" &&
        flag !== "--batch-size" && flag !== "--concurrency" && flag !== "--gpu-ids" && flag !== "--guard") {
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
    if (flag === "--gpu-ids") gpuIds = value;
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
    if (gpuIds && mode.split(",").includes("parallel") &&
        (mode.split(",").includes("cuda") || mode.split(",").includes("dml") ||
         mode.split(",").includes("webgpu"))) {
      args.push("--gpu-ids", gpuIds);
    }
    const parsed = parseAccelerationFlags(args);
    if (parsed.remaining.length || !accelerationNames(parsed.acceleration).length) {
      throw new Error("Invalid mode: " + mode);
    }
  }
  return { project, seconds, modes: selected, batchSize, concurrency, gpuIds, guard };
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

function decodeEvent(line: string): ScanTelemetry {
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
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    console.error("Could not terminate scan process group; stopping child directly.");
    return false;
  }
}

// A separate deadline kills the scan and its worker tree even if inference stalls.
async function runMode(settings: ThroughputOptions, mode: string): Promise<ScanResult> {
  const result: ScanResult = {
    mode, secondsLimit: settings.seconds, elapsedSeconds: 0, timedOut: false,
    completed: false, exitCode: null, loadedFiles: 0, enabledRules: 0,
    stage: "starting", completedStages: 0, totalStages: 0, stageFindings: 0,
    completedInferenceWindows: 0, completedInferenceCalls: 0,
    crossQuestionBatches: 0, maximumBatchSize: 0, completedSemanticQuestions: 0,
    cacheHits: 0, provider: "not initialised", gpuWindows: {}, gpuProviderProof: {}, error: null
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = [
    "src/cli.ts", ...(settings.guard === "all" ? [] : [settings.guard]),
    "--project", settings.project, "--benchmark-telemetry",
    "--accelerate", mode,
    ...(mode.split(",").includes("batch") ? ["--batch-size", String(settings.batchSize)] : []),
    ...(mode.split(",").includes("parallel") ? ["--concurrency", String(settings.concurrency)] : []),
    ...(settings.gpuIds && mode.split(",").includes("parallel") &&
      (mode.split(",").includes("cuda") || mode.split(",").includes("dml") ||
       mode.split(",").includes("webgpu"))
      ? ["--gpu-ids", settings.gpuIds] : [])
  ];
  const started = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    // On POSIX, make an independent process group so the deadline can also
    // terminate any CUDA model workers started by this scan.
    detached: process.platform !== "win32"
  });
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
  const terminate = (): void => {
    const pid = child.pid ?? null;
    if (pid !== null && process.platform === "win32" && killTree(pid)) return;
    if (pid !== null && process.platform !== "win32" && killGroup(pid)) return;
    child.kill("SIGKILL");
  };
  const deadline = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      result.timedOut = true;
      terminate();
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
      result.error = usefulBenchmarkError(diagnostics) ?? ("Child exited with code " + String(close.code));
    }
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && !result.timedOut) terminate();
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
