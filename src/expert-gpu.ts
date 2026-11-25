import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GpuMemoryMonitor, parseMemoryMap, readNvidiaMemory, type DeviceMemory } from "./gpu-memory.ts";
import { parseRecord, type JsonValue } from "./json.ts";
import { semanticAccelerationConfig } from "./semantic.ts";
import type { AccelerationConfig } from "./acceleration.ts";
import type { EmbeddingRuntime, ExpertProfile } from "./experts.ts";

export type ExpertGpu = {adapter: number; uuid: string; budgetMiB: number; python: string; identity: string};

export function validateExpertAdapter(adapter: number, uuid: string, judge: AccelerationConfig, mapping: string): void {
  if (!Number.isSafeInteger(adapter) || adapter < 0 || adapter > 15 || !/^GPU-[a-fA-F0-9-]+$/.test(uuid)) throw new Error("Invalid expert GPU adapter or UUID.");
  const gpu = ["cuda", "dml", "webgpu"].filter(device => [...judge.features].some(feature => feature === device));
  if (!gpu.length) return;
  if (gpu.length !== 1 || !gpu.includes("webgpu") || !judge.gpuIds.length) {
    throw new Error("Expert WebGPU requires explicit native WebGPU judge selection or a CPU judge.");
  }
  const judgeDevices = parseMemoryMap(mapping, judge.gpuIds);
  const mapped = judgeDevices.get(adapter) ?? null;
  if (mapped !== null && mapped !== uuid) throw new Error("Expert adapter UUID contradicts the judge mapping.");
  if (mapped === null && [...judgeDevices.values()].includes(uuid)) throw new Error("Expert UUID is mapped to another judge adapter.");
}

export function configuredExpertGpu(): ExpertGpu | null {
  const ordinal = process.env.CODE_GUARDS_EXPERT_GPU_ADAPTER ?? "";
  const otherSettings = (process.env.CODE_GUARDS_EXPERT_GPU_UUID ?? "") || (process.env.CODE_GUARDS_EXPERT_GPU_BUDGET_MIB ?? "");
  if (!ordinal && otherSettings) throw new Error("Expert GPU settings require an explicit adapter ordinal.");
  if (!ordinal) return null;
  const adapter = Number(ordinal);
  const uuid = process.env.CODE_GUARDS_EXPERT_GPU_UUID ?? "";
  validateExpertAdapter(adapter, uuid, semanticAccelerationConfig(), process.env.CODE_GUARDS_GPU_MEMORY_MAP ?? "");
  const expertLimit = Number(process.env.CODE_GUARDS_EXPERT_GPU_BUDGET_MIB ?? "");
  const judgeLimit = Number(process.env.CODE_GUARDS_GPU_MEMORY_BUDGET_MIB ?? "0");
  const budgetMiB = semanticAccelerationConfig().gpuIds.includes(adapter) ? Math.min(expertLimit, judgeLimit) : expertLimit;
  if (!Number.isSafeInteger(budgetMiB) || budgetMiB < 1) throw new Error("Set a positive expert GPU memory budget.");
  const python = process.env.CODE_GUARDS_WEBGPU_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const versions = spawnSync(python, ["-c", "from importlib.metadata import version; print(':'.join(version(x) for x in ('onnxruntime','onnxruntime-ep-webgpu','tokenizers','numpy')))"], {encoding: "utf8", timeout: 10000, windowsHide: true});
  if (versions.status !== 0 || typeof versions.stdout !== "string" || !versions.stdout.trim()) throw new Error("Cannot identify native expert runtime versions.");
  return {adapter, uuid, budgetMiB, python, identity: "native-webgpu-mean-v1:" + uuid + ":" + versions.stdout.trim()};
}

/** Check physical headroom before a cold load; the live monitor remains authoritative. */
export function requireExpertHeadroom(device: DeviceMemory, budgetMiB: number, weightBytes: number): void {
  // Reserve room for the weights and execution scratch space. This is an
  // admission estimate, not a promise about an ONNX session's peak usage.
  const reserve = Math.ceil(weightBytes / 1048576) + 2048;
  const available = Math.min(device.totalMiB, budgetMiB) - device.usedMiB;
  if (available < reserve) throw new Error(`Insufficient specialist GPU headroom: ${available} MiB available, ${reserve} MiB admission reserve.`);
}

function decodeRow(value: JsonValue, dimensions: number): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== dimensions) throw new Error("Invalid GPU embedding dimensions.");
  return value.map(item => {
    if (typeof item !== "number" || !Number.isFinite(item)) throw new Error("Invalid GPU embedding value.");
    return item;
  });
}

export function decodeEmbeddingRows(value: JsonValue, dimensions: number): (number[] | null)[] {
  if (!Array.isArray(value)) throw new Error("Invalid GPU embedding response.");
  return value.map(row => decodeRow(row, dimensions));
}

function workerPath(): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const file = [join(base, "..", "scripts", "native-webgpu-worker.py"),
    join(base, "..", "..", "scripts", "native-webgpu-worker.py")].find(existsSync) ?? null;
  if (!file) throw new Error("Native GPU worker script is missing.");
  return file;
}

type Pending = {resolve: (rows: (number[] | null)[]) => void; reject: (error: Error) => void};

class GpuEmbeddingProcess {
  private pending: Pending | null = null;
  private failure: Error | null = null;
  private closing = false;
  private readonly exit: Promise<number>;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly memory: GpuMemoryMonitor;
  private readonly ready: Promise<void>;
  private readyResolve: () => void = () => {};
  private readyReject: (error: Error) => void = () => {};
  private diagnostics = "";

  constructor(private readonly profile: ExpertProfile, gpu: ExpertGpu) {
    const device = readNvidiaMemory().find(item => item.uuid === gpu.uuid) ?? null;
    if (!device) throw new Error("Mapped expert GPU is unavailable.");
    requireExpertHeadroom(device, gpu.budgetMiB, profile.weightBytes);
    this.memory = new GpuMemoryMonitor(new Map([[gpu.adapter, gpu.uuid]]), gpu.budgetMiB);
    this.memory.sample("before-load");
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.child = spawn(gpu.python, [workerPath()], {windowsHide: true, env: {
      ...process.env, CODE_GUARDS_GPU_WORKER_ID: String(gpu.adapter),
      CODE_GUARDS_GPU_BATCH_SIZE: String(profile.batchSize),
      CODE_GUARDS_EMBEDDING_MODEL: profile.model, CODE_GUARDS_EMBEDDING_REVISION: profile.revision,
      CODE_GUARDS_EMBEDDING_CONTEXT: String(profile.contextTokens), CODE_GUARDS_EMBEDDING_DIMENSIONS: String(profile.dimensions)
    }});
    this.exit = new Promise<number>(resolve => {
      this.child.once("close", code => {
        if (!this.closing || code !== 0 || this.pending) this.fail(new Error("Expert worker exited: " + this.diagnostics));
        resolve(code ?? -1);
      });
      this.child.once("error", error => {this.fail(error); resolve(-1);});
    });
    this.child.stdin.on("error", error => this.fail(error));
    this.child.stderr.on("data", (chunk: Buffer) => {this.diagnostics = (this.diagnostics + chunk.toString()).slice(-4096);});
    const lines = createInterface({input: this.child.stdout, crlfDelay: Infinity});
    lines.on("line", line => this.receive(line));
    this.timer = setInterval(() => {
      try { this.memory.sample("active"); }
      catch (error) { this.fail(error instanceof Error ? error : new Error("Expert GPU memory monitoring failed.")); }
    }, 1000);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.readyReject(error);
    const request = this.pending;
    this.pending = null;
    if (request) request.reject(error);
    this.child.kill("SIGKILL");
  }

  private receive(line: string): void {
    if (!line.startsWith("{")) return;
    try {
      const message = parseRecord(line);
      switch (message.text("type")) {
        case "ready": this.readyResolve(); return;
        case "timing": console.error("CG_EXPERT_PROVIDER " + line); return;
        case "fatal": this.fail(new Error(message.text("message"))); return;
        case "embeddings": this.complete(decodeEmbeddingRows(message.get("rows"), this.profile.dimensions)); return;
        default: throw new Error("Unexpected expert worker event.");
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error("Invalid expert worker response.")); }
  }

  private complete(rows: (number[] | null)[]): void {
    const pending = this.pending;
    if (!pending) throw new Error("Unsolicited embedding batch.");
    this.pending = null;
    pending.resolve(rows);
  }

  async initialise(): Promise<void> { await this.ready; }

  async embed(passages: readonly string[]): Promise<(number[] | null)[]> {
    if (this.failure) throw this.failure;
    if (this.closing || this.pending) throw new Error("Expert worker unavailable.");
    const result = await new Promise<(number[] | null)[]>((resolve, reject) => {
      this.pending = {resolve, reject};
      this.child.stdin.write(JSON.stringify({passages}) + "\n");
    });
    if (result.length !== passages.length) throw new Error("Incomplete GPU embedding batch.");
    return result;
  }

  // End-of-input drains the accepted request; the final memory measurement
  // is taken only once the isolated process has actually exited.
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.child.stdin.end();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<number>(resolve => {timeout = setTimeout(() => resolve(-1), 120000);});
    try {
      const code = await Promise.race([this.exit, deadline]);
      if (code !== 0) {
        this.child.kill("SIGKILL");
        await this.exit;
        throw this.failure ?? new Error("Expert worker shutdown failed.");
      }
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      clearInterval(this.timer);
      this.memory.sample("after-exit");
    }
  }
}

/** Allocate a native GPU model only on an embedding-cache miss. */
export async function openGpuEmbeddingRuntime(profile: ExpertProfile, gpu: ExpertGpu): Promise<EmbeddingRuntime> {
  const process = new GpuEmbeddingProcess(profile, gpu);
  try { await process.initialise(); }
  catch (error) { await process.close(); throw error instanceof Error ? error : new Error("Expert GPU initialisation failed."); }
  return {embed: passages => process.embed(passages), dispose: () => process.close()};
}
