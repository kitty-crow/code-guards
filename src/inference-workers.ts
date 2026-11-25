/** Native DirectML / GPU affinity via isolated model child processes. */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AccelerationConfig } from "./acceleration.ts";
import { configuredGpuMemoryMonitor } from "./gpu-memory.ts";
import { parseRecord, JsonRecord } from "./json.ts";
import { comparisonQuestion, type SemanticQuestion, type SemanticTimingEvent, type WindowVerdict, type NativeWindowVerdict, type NliLogits, type RawNliWindow } from "./semantic.ts";

type WorkerEvent = { type: "loading" | "ready"; gpuId: number; backend: "cuda" | "dml" | "webgpu" | "cpu" } |
  { type: "timing"; gpuId: number; timing: SemanticTimingEvent };
type Pending = { resolve: (value: WindowVerdict) => void; reject: (reason: Error) => void };
type Worker = {
  child: ChildProcess;
  id: number;
  requests: Map<number, Pending>;
  failed: Error | null;
  diagnostics: string[];
  exit: Promise<boolean>;
};

export type GpuWorkerPool = {
  score: (question: SemanticQuestion) => Promise<WindowVerdict>;
  close: () => void;
};

export type ManagedWorkerPool = GpuWorkerPool & { drainAndClose: () => Promise<void> };

/** Delay worker allocation until a semantic question actually needs a model. */
export function createLazyWorkerPool(factory: () => ManagedWorkerPool): ManagedWorkerPool {
  let pool: ManagedWorkerPool | null = null;
  let closed = false;
  return {
    score: async question => {
      if (closed) throw new Error("GPU worker pool has closed.");
      pool ??= factory();
      return pool.score(question);
    },
    close: () => {
      closed = true;
      if (pool) pool.close();
    },
    drainAndClose: async () => {
      closed = true;
      if (pool) await pool.drainAndClose();
    }
  };
}

/**
 * Select the worker with the fewest unfinished questions. Rotate ties so that
 * workers with equal queue depth do not always favour the first adapter.
 * Counts include running work as well as queued requests.
 */
export function leastPendingWorkerIndex(counts: readonly number[], start: number): number {
  if (!counts.length || !Number.isSafeInteger(start) || start < 0) {
    throw new Error("Invalid GPU worker selection.");
  }
  let selected = -1;
  let minimum = Infinity;
  for (let offset = 0; offset < counts.length; offset += 1) {
    const index = (start + offset) % counts.length;
    const count = counts[index] ?? null;
    if (count === null || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid GPU pending request count.");
    }
    if (count < minimum) {
      minimum = count;
      selected = index;
    }
  }
  return selected;
}

export function decodeSemanticQuestion(payload: JsonRecord): SemanticQuestion {
  const question = {premise: payload.text("premise"), same: payload.text("same"), different: payload.text("different")};
  const comparison = payload.get("comparison");
  if (comparison === null) return question;
  if (!(comparison instanceof JsonRecord)) throw new Error("Invalid paired semantic evidence.");
  const left = comparison.record("left");
  const right = comparison.record("right");
  return comparisonQuestion(question, {name: left.text("name"), evidence: left.text("evidence")},
    {name: right.text("name"), evidence: right.text("evidence")});
}

function decodeTiming(data: JsonRecord, gpuId: number | null): SemanticTimingEvent {
  const phase = data.text("phase");
  const milliseconds = data.number("milliseconds");
  switch (phase) {
    case "model-load": return { phase, milliseconds };
    case "cache-hit": return { phase, milliseconds };
    case "windowing": return { phase, milliseconds, windows: data.number("windows") };
    case "verdict": return { phase, milliseconds, windows: data.number("windows") };
    case "inference": {
      const questions = data.get("distinctQuestions");
      return { phase, milliseconds, gpuId, window: data.number("window"),
        windows: data.number("windows"), batchSize: data.number("batchSize"),
        distinctQuestions: typeof questions === "number" ? questions : 1 };
    }
    case "provider-proof": return { phase, milliseconds, gpuId,
      gpuNodes: data.number("gpuNodes"), cpuNodes: data.number("cpuNodes"),
      gpuOps: data.strings("gpuOps"), gpuTimeMs: data.number("gpuTimeMs"), cpuTimeMs: data.number("cpuTimeMs") };
    default: throw new Error("Invalid GPU timing phase: " + phase);
  }
}

function decodeLogits(record: JsonRecord): NliLogits {
  return {entailment: record.number("entailment"), neutral: record.number("neutral"),
    contradiction: record.number("contradiction")};
}

function decodeRawWindow(record: JsonRecord): RawNliWindow {
  const value = record.get("logits");
  if (value === null) return {window: record.number("window"), logits: null};
  if (!(value instanceof JsonRecord)) throw new Error("Invalid raw NLI evidence.");
  return {window: record.number("window"), logits: {
    support: decodeLogits(value.record("support")), opposition: decodeLogits(value.record("opposition"))
  }};
}

function decodeVerdict(data: JsonRecord): WindowVerdict | NativeWindowVerdict {
  const evidence = data.record("evidence");
  const sameConcept = data.number("sameConcept");
  const differentConcept = data.number("differentConcept");
  if (sameConcept < 0 || sameConcept > 1 || differentConcept < 0 || differentConcept > 1) {
    throw new Error("GPU worker returned an invalid semantic score.");
  }
  const verdict: WindowVerdict = { sameConcept, differentConcept, evidence: {
    windows: evidence.number("windows"), supportWindow: evidence.number("supportWindow"),
    oppositionWindow: evidence.number("oppositionWindow")
  } };
  const raw = data.get("rawEvidence");
  if (raw === null) return verdict;
  if (!Array.isArray(raw) || raw.length !== verdict.evidence.windows) throw new Error("Incomplete raw NLI window list.");
  const rawEvidence = raw.map(item => {
    if (!(item instanceof JsonRecord)) throw new Error("Invalid raw NLI window record.");
    return decodeRawWindow(item);
  });
  if (rawEvidence.some((item, index) => item.window !== index + 1)) throw new Error("Unordered raw NLI evidence.");
  return {...verdict, rawEvidence};
}

// EOF lets workers finish accepted requests, dispose the model and commit
// completed cache entries. The timeout is a failure boundary, not a success.
async function drainWorkers(workers: Worker[], reject: (worker: Worker, failure: Error) => void): Promise<void> {
  for (const worker of workers) {
    const input = worker.child.stdin;
    if (input) input.end();
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<boolean[]>(resolve => {
    timer = setTimeout(() => resolve([]), 120000);
  });
  try {
    const results = await Promise.race([Promise.all(workers.map(worker => worker.exit)), deadline]);
    if (results.length === workers.length && results.every(Boolean) && workers.every(worker => !worker.failed && !worker.requests.size)) return;
    const original = workers.find(worker => worker.failed !== null)?.failed ?? null;
    const failure = original ?? new Error("Inference workers did not drain and exit successfully.");
    for (const worker of workers) {
      reject(worker, failure);
      worker.child.kill("SIGKILL");
    }
    throw failure;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Bind each worker to a selected GPU adapter through native execution providers. */
export function createGpuWorkerPool(
  ids: readonly number[],
  config: AccelerationConfig,
  event: (message: WorkerEvent) => void
): ManagedWorkerPool {
  const backend = config.features.has("webgpu") ? "webgpu"
    : process.platform === "win32" ? "dml"
    : process.platform === "linux" ? "cuda" : null;
  if (!backend || !config.features.has(backend) || !config.features.has("parallel") ||
      ids.length < 1 || ids.length > 16 || new Set(ids).size !== ids.length ||
      ids.some(id => !Number.isSafeInteger(id) || id < 0 || id > 15) ||
      (backend === "dml" && process.platform !== "win32") ||
      (backend === "cuda" && process.platform !== "linux") ||
      (backend === "webgpu" && process.platform !== "win32")) {
    throw new Error("Explicit GPU workers require parallel,dml (Windows), parallel,cuda (Linux), or parallel,webgpu (Windows native plugin).");
  }
  return createWorkerPool(ids, config, backend, event);
}

/** Explicit CPU FP32 worker using the native model and portable cache. */
export function createNativeCpuWorkerPool(
  config: AccelerationConfig, event: (message: WorkerEvent) => void
): ManagedWorkerPool {
  return createWorkerPool([0], config, "cpu", event);
}

function createWorkerPool(
  ids: readonly number[], config: AccelerationConfig,
  backend: "cuda" | "dml" | "webgpu" | "cpu",
  event: (message: WorkerEvent) => void
): ManagedWorkerPool {
  const native = backend === "webgpu" || backend === "cpu";
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const extension = fileURLToPath(import.meta.url).endsWith(".js") ? "js" : "ts";
  const nativeWorkerCandidates = [
    join(sourceDir, "..", "scripts", "native-webgpu-worker.py"),
    join(sourceDir, "..", "..", "scripts", "native-webgpu-worker.py")
  ];
  const nativeWorkerFile = nativeWorkerCandidates.find(candidate => existsSync(candidate)) ?? null;
  if (native && !nativeWorkerFile) {
    throw new Error("Native WebGPU adapter worker script is missing.");
  }
  const workerFile = join(sourceDir, "inference-worker." + extension);
  const workers: Worker[] = [];
  const memory = backend === "cpu" ? null : configuredGpuMemoryMonitor(ids);
  if (memory) memory.sample("before-load");
  let nextId = 0;
  let nextWorker = 0;
  let closed = false;
  let draining: Promise<void> | null = null;

  function rejectWorker(worker: Worker, failure: Error): void {
    if (worker.failed) return;
    worker.failed = failure;
    for (const request of worker.requests.values()) request.reject(failure);
    worker.requests.clear();
  }

  for (const id of ids) {
    // The current ONNX Runtime Node binding does not expose physical
    // WebGPU adapter selection. The native plugin's Python binding does.
    // Code Guards and scheduling remain in Bun; only GPU execution is external.
    const executable = native
      ? process.env.CODE_GUARDS_WEBGPU_PYTHON ?? (process.platform === "win32" ? "python" : "python3")
      : process.execPath;
    const args = native ? [nativeWorkerFile ?? ""] : [workerFile];
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(backend === "cuda" ? { CUDA_VISIBLE_DEVICES: String(id) } : {}),
        CODE_GUARDS_GPU_BACKEND: backend,
        CODE_GUARDS_GPU_WORKER_ID: String(id),
        CODE_GUARDS_GPU_BATCH_SIZE: String(config.batchSize),
        CODE_GUARDS_GPU_BATCH: config.features.has("batch") ? "1" : "0",
        CODE_GUARDS_GPU_CACHE: config.features.has("cache") ? "1" : "0"
      },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    const exit = new Promise<boolean>(resolve => {
      child.once("close", code => resolve(code === 0));
      child.once("error", () => resolve(false));
    });
    const worker: Worker = { child, id, requests: new Map<number, Pending>(), failed: null, diagnostics: [], exit };
    workers.push(worker);
    // The native ONNX model worker can terminate during initialisation.
    // Without a listener, EPIPE on Bun's Writable stdin can become an
    // unhandled process error instead of a useful diagnostic.
    const input = child.stdin;
    const stderr = child.stderr;
    if (!input || !stderr) throw new Error("Could not open GPU worker pipes.");
    input.on("error", error => {
      // A broken pipe is usually secondary to a native worker failure.
      // Keep it as a diagnostic, but let the worker's fatal IPC message
      // or close event report the original exception.
      worker.diagnostics.push("Worker stdin: " + error.message);
    });
    stderr.on("data", (data: Buffer | string) => {
      const lines = String(data).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      worker.diagnostics.push(...lines);
      if (worker.diagnostics.length > 32) worker.diagnostics.splice(0, worker.diagnostics.length - 32);
    });
    const output = child.stdout;
    if (!output) throw new Error("Could not read GPU worker output.");
    const lines = createInterface({ input: output, crlfDelay: Infinity });
    lines.on("line", line => {
      let message: JsonRecord;
      try { message = parseRecord(line); }
      catch {
        // Native runtimes sometimes print diagnostics to stdout.
        if (line.trim()) worker.diagnostics.push(line.trim());
        if (worker.diagnostics.length > 32) worker.diagnostics.splice(0, worker.diagnostics.length - 32);
        return;
      }
      try {
        if (message.get("gpuId") !== id) return;
        const type = message.text("type");
        switch (type) {
          case "ready":
          case "loading":
            event({ type, gpuId: id, backend });
            return;
          case "timing":
            event({ type, gpuId: id, timing: decodeTiming(message.record("timing"), backend === "cpu" ? null : id) });
            return;
          case "result": {
            const requestId = message.number("id");
            const request = worker.requests.get(requestId) ?? null;
            if (!request) return;
            const verdict = decodeVerdict(message.record("verdict"));
            worker.requests.delete(requestId);
            request.resolve(verdict);
            return;
          }
          case "fatal":
            rejectWorker(worker, new Error("GPU " + id + " worker failed: " + message.text("message")));
            child.kill("SIGKILL");
            return;
          default:
            throw new Error("Unrecognised GPU worker message: " + type);
        }
      } catch (error) {
        rejectWorker(worker, error instanceof Error ? error : new Error("Invalid GPU worker response."));
        child.kill("SIGKILL");
      }
    });
    child.once("error", error => rejectWorker(worker,
      new Error("GPU " + id + " worker process failed: " + error.message)));
    child.once("close", (code, signal) => {
      if (!worker.failed && (!closed || worker.requests.size > 0 || code !== 0)) {
        const detail = worker.diagnostics.slice(-12).join(" | ");
        rejectWorker(worker, new Error("GPU " + id + " worker exited: " +
          String(code ?? signal) + (detail ? ". Native stderr: " + detail : "")));
      }
    });
  }

  // Sample independently of IPC progress so a long-running model load or
  // question cannot defer budget enforcement until its result arrives.
  const memoryTimer = memory ? setInterval(() => {
    try { memory.sample("active"); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error("GPU memory monitoring failed.");
      for (const worker of workers) {
        rejectWorker(worker, failure);
        worker.child.kill("SIGKILL");
      }
    }
  }, 1000) : null;

  function stopMonitoring(): void {
    if (memoryTimer !== null) clearInterval(memoryTimer);
  }

  return {
    score: (question): Promise<WindowVerdict> => {
      if (closed) return Promise.reject(new Error("GPU worker pool has closed."));
      const index = leastPendingWorkerIndex(
        workers.map(candidate => candidate.requests.size), nextWorker
      );
      nextWorker = (index + 1) % workers.length;
      const worker = workers[index] ?? null;
      if (!worker) return Promise.reject(new Error("No GPU worker available."));
      if (worker.failed) return Promise.reject(worker.failed);
      const input = worker.child.stdin;
      if (!input || input.destroyed) return Promise.reject(new Error("GPU " + worker.id + " worker input is unavailable."));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        worker.requests.set(id, { resolve, reject });
        try {
          input.write(JSON.stringify({ id, question }) + "\n", (error: Error | null = null) => {
            if (error instanceof Error) {
              // The subprocess may have emitted a more useful fatal error.
              // Save EPIPE for the close handler rather than masking it.
              worker.diagnostics.push("Worker write: " + error.message);
            }
          });
        } catch (error) {
          rejectWorker(worker, error instanceof Error ? error : new Error("GPU worker write failed."));
        }
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      stopMonitoring();
      for (const worker of workers) {
        rejectWorker(worker, new Error("GPU worker pool closed."));
        worker.child.kill("SIGKILL");
      }
    },
    drainAndClose(): Promise<void> {
      if (draining) return draining;
      if (closed) return Promise.resolve();
      closed = true;
      draining = drainWorkers(workers, rejectWorker).finally(() => {
        stopMonitoring();
        if (memory) memory.sample("after-exit");
      });
      return draining;
    }
  };
}
