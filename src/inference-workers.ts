/** Native DirectML / GPU affinity via isolated model child processes. */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccelerationConfig } from "./acceleration.ts";
import type { SemanticQuestion, SemanticTimingEvent, WindowVerdict } from "./semantic.ts";

type WorkerEvent = { type: "loading" | "ready"; gpuId: number } |
  { type: "timing"; gpuId: number; timing: SemanticTimingEvent };
type Pending = { resolve: (value: WindowVerdict) => void; reject: (reason: Error) => void };
type Worker = {
  child: ChildProcess;
  id: number;
  requests: Map<number, Pending>;
  failed: Error | null;
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
  const backend = process.platform === "win32" ? "dml" : process.platform === "linux" ? "cuda" : null;
  if (!backend || !config.features.has(backend) || !config.features.has("parallel") || ids.length < 2) {
    throw new Error("GPU workers require parallel,dml on native Windows or parallel,cuda on Linux.");
  }
  const extension = fileURLToPath(import.meta.url).endsWith(".js") ? "js" : "ts";
  const workerFile = join(dirname(fileURLToPath(import.meta.url)), "inference-worker." + extension);
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
    const child = spawn(process.execPath, [workerFile], {
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
      stdio: ["pipe", "pipe", "inherit"], windowsHide: true
    });
    const worker: Worker = { child, id, requests: new Map(), failed: null };
    workers.push(worker);
    const output = child.stdout;
    if (!output) throw new Error("Could not read GPU worker output.");
    const lines = createInterface({ input: output, crlfDelay: Infinity });
    lines.on("line", line => {
      let message: unknown;
      try { message = JSON.parse(line); }
      catch { return; } // ONNX Runtime may also write diagnostics to stdout.
      if (!message || typeof message !== "object" || !("type" in message) ||
          !("gpuId" in message) || message.gpuId !== id) return;
      if (message.type === "ready" || message.type === "loading") {
        event({ type: message.type, gpuId: id });
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
    child.once("error", error => rejectWorker(worker, error));
    child.once("exit", (code, signal) => {
      if (!closed) rejectWorker(worker, new Error("GPU " + id +
        " worker exited: " + String(code ?? signal)));
    });
  }

  return {
    score(question): Promise<WindowVerdict> {
      if (closed) return Promise.reject(new Error("GPU worker pool has closed."));
      const worker = workers[nextWorker++ % workers.length];
      if (!worker) return Promise.reject(new Error("No GPU worker available."));
      if (worker.failed) return Promise.reject(worker.failed);
      const input = worker.child.stdin;
      if (!input || input.destroyed) return Promise.reject(new Error("GPU worker input is unavailable."));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        worker.requests.set(id, { resolve, reject });
        input.write(JSON.stringify({ id, question }) + "\n", error => {
          if (error) {
            worker.requests.delete(id);
            reject(error);
          }
        });
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
