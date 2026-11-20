/** Native DirectML / GPU affinity via isolated model child processes. */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AccelerationConfig } from "./acceleration.ts";
import type { SemanticQuestion, SemanticTimingEvent, WindowVerdict } from "./semantic.ts";

type WorkerEvent = { type: "loading" | "ready"; gpuId: number; backend?: "cuda" | "dml" | "webgpu" } |
  { type: "timing"; gpuId: number; timing: SemanticTimingEvent };
type Pending = { resolve: (value: WindowVerdict) => void; reject: (reason: Error) => void };
type Worker = {
  child: ChildProcess;
  id: number;
  requests: Map<number, Pending>;
  failed: Error | null;
  diagnostics: string[];
};

export type GpuWorkerPool = {
  score: (question: SemanticQuestion) => Promise<WindowVerdict>;
  close: () => void;
};

/** Bind each worker to a physical adapter through DirectML (Windows) or CUDA (Linux). */
export function createGpuWorkerPool(
  ids: readonly number[],
  config: AccelerationConfig,
  event: (message: WorkerEvent) => void
): GpuWorkerPool {
  const backend = config.features.has("webgpu") ? "webgpu"
    : process.platform === "win32" ? "dml"
    : process.platform === "linux" ? "cuda" : null;
  if (!backend || !config.features.has(backend) || !config.features.has("parallel") || ids.length < 2 ||
      (backend === "dml" && process.platform !== "win32") ||
      (backend === "cuda" && process.platform !== "linux") ||
      (backend === "webgpu" && process.platform !== "win32")) {
    throw new Error("Explicit GPU workers require parallel,dml (Windows), parallel,cuda (Linux), or parallel,webgpu (Windows native plugin).");
  }
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const extension = fileURLToPath(import.meta.url).endsWith(".js") ? "js" : "ts";
  const nativeWorkerCandidates = [
    join(sourceDir, "..", "scripts", "native-webgpu-worker.py"),
    join(sourceDir, "..", "..", "scripts", "native-webgpu-worker.py")
  ];
  const nativeWorkerFile = nativeWorkerCandidates.find(candidate => existsSync(candidate));
  if (backend === "webgpu" && !nativeWorkerFile) {
    throw new Error("Native WebGPU adapter worker script is missing.");
  }
  const workerFile = join(sourceDir, "inference-worker." + extension);
  const workers: Worker[] = [];
  let nextId = 0;
  let nextWorker = 0;
  let closed = false;

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
    const executable = backend === "webgpu"
      ? process.env.CODE_GUARDS_WEBGPU_PYTHON ?? "python"
      : process.execPath;
    const args = backend === "webgpu" ? [nativeWorkerFile ?? ""] : [workerFile];
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
    const worker: Worker = { child, id, requests: new Map(), failed: null, diagnostics: [] };
    workers.push(worker);
    // The native ONNX model worker can terminate during initialisation.
    // Without a listener, EPIPE on Bun's Writable stdin can become an
    // unhandled process error instead of a useful diagnostic.
    child.stdin?.on("error", error => {
      // A broken pipe is usually secondary to a native worker failure.
      // Keep it as a diagnostic, but let the worker's fatal IPC message
      // or close event report the original exception.
      worker.diagnostics.push("Worker stdin: " + error.message);
    });
    child.stderr?.on("data", (data: Buffer | string) => {
      const lines = String(data).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      worker.diagnostics.push(...lines);
      if (worker.diagnostics.length > 32) worker.diagnostics.splice(0, worker.diagnostics.length - 32);
    });
    const output = child.stdout;
    if (!output) throw new Error("Could not read GPU worker output.");
    const lines = createInterface({ input: output, crlfDelay: Infinity });
    lines.on("line", line => {
      let message: unknown;
      try { message = JSON.parse(line); }
      catch {
        // Native runtimes sometimes print errors directly to stdout.
        // Preserve them so the parent can report a useful failure.
        if (line.trim()) worker.diagnostics.push(line.trim());
        if (worker.diagnostics.length > 32) worker.diagnostics.splice(0, worker.diagnostics.length - 32);
        return;
      }
      if (!message || typeof message !== "object" || !("type" in message) ||
          !("gpuId" in message) || message.gpuId !== id) return;
      if (message.type === "ready" || message.type === "loading") {
        event({ type: message.type, gpuId: id, backend });
      } else if (message.type === "timing" && "timing" in message &&
                 typeof message.timing === "object" && message.timing !== null) {
        event({ type: "timing", gpuId: id, timing: message.timing as SemanticTimingEvent });
      } else if (message.type === "result" && "id" in message && typeof message.id === "number" &&
                 "verdict" in message && message.verdict && typeof message.verdict === "object") {
        const request = worker.requests.get(message.id);
        if (!request) return;
        worker.requests.delete(message.id);
        request.resolve(message.verdict as WindowVerdict);
      } else if (message.type === "fatal") {
        const explanation = "message" in message ? String(message.message) : "unknown failure";
        rejectWorker(worker, new Error("GPU " + id + " worker failed: " + explanation));
        child.kill("SIGKILL");
      }
    });
    child.once("error", error => rejectWorker(worker,
      new Error("GPU " + id + " worker process failed: " + error.message)));
    child.once("close", (code, signal) => {
      if (!closed && !worker.failed) {
        const detail = worker.diagnostics.slice(-12).join(" | ");
        rejectWorker(worker, new Error("GPU " + id + " worker exited: " +
          String(code ?? signal) + (detail ? ". Native stderr: " + detail : "")));
      }
    });
  }

  return {
    score(question): Promise<WindowVerdict> {
      if (closed) return Promise.reject(new Error("GPU worker pool has closed."));
      const worker = workers[nextWorker++ % workers.length];
      if (!worker) return Promise.reject(new Error("No GPU worker available."));
      if (worker.failed) return Promise.reject(worker.failed);
      const input = worker.child.stdin;
      if (!input || input.destroyed) return Promise.reject(new Error("GPU " + worker.id + " worker input is unavailable."));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        worker.requests.set(id, { resolve, reject });
        try {
          input.write(JSON.stringify({ id, question }) + "\n", error => {
            if (error) {
              // The subprocess may have emitted a more useful fatal error.
              // Save EPIPE for the close handler rather than masking it.
              worker.diagnostics.push("Worker write: " + error.message);
            }
          });
        } catch (error) {
          rejectWorker(worker, error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const worker of workers) {
        rejectWorker(worker, new Error("GPU worker pool closed."));
        worker.child.kill("SIGKILL");
      }
    }
  };
}
