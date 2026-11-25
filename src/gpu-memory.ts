import { spawnSync } from "node:child_process";

export type DeviceMemory = {uuid: string; usedMiB: number; totalMiB: number};
export type MemoryPhase = "before-load" | "active" | "after-exit";
export type DeviceMemorySample = DeviceMemory & {adapter: number; phase: MemoryPhase; baselineMiB: number; peakSampledMiB: number};
export type MemoryReader = () => DeviceMemory[];

/** GPU enumeration order is provider-specific; only explicit UUID mappings establish identity. */
export function parseMemoryMap(input: string, adapters: readonly number[]): Map<number, string> {
  const result = new Map<number, string>();
  for (const entry of input.split(",")) {
    const match = /^([0-9]+)=(GPU-[a-fA-F0-9-]+)$/.exec(entry.trim());
    if (!match) throw new Error("Invalid GPU memory map; expected adapter=GPU-uuid.");
    const adapter = Number(match[1] ?? "");
    const uuid = match[2] ?? "";
    if (!adapters.includes(adapter) || result.has(adapter) || [...result.values()].includes(uuid)) throw new Error("Invalid or duplicate GPU memory mapping.");
    result.set(adapter, uuid);
  }
  if (result.size !== adapters.length) throw new Error("GPU memory map must cover every selected adapter.");
  return result;
}

export function readNvidiaMemory(): DeviceMemory[] {
  const result = spawnSync("nvidia-smi", ["--query-gpu=uuid,memory.used,memory.total", "--format=csv,noheader,nounits"],
    {encoding: "utf8", windowsHide: true, timeout: 3000});
  if (result.status !== 0 || typeof result.stdout !== "string") throw new Error("Could not sample GPU memory with nvidia-smi.");
  return result.stdout.trim().split(/\r?\n/).map(line => {
    const parts = line.split(",").map(value => value.trim());
    const uuid = parts[0] ?? "";
    const usedMiB = Number(parts[1] ?? "");
    const totalMiB = Number(parts[2] ?? "");
    if (parts.length !== 3 || !/^GPU-[a-fA-F0-9-]+$/.test(uuid) ||
        !Number.isFinite(usedMiB) || !Number.isFinite(totalMiB) || usedMiB < 0 || totalMiB <= 0 || usedMiB > totalMiB) {
      throw new Error("Invalid GPU memory telemetry.");
    }
    return {uuid, usedMiB, totalMiB};
  });
}

/** Sample total physical-device usage, not an estimate of per-process allocation. */
export class GpuMemoryMonitor {
  private readonly baseline = new Map<number, number>();
  private readonly peaks = new Map<number, number>();

  constructor(private readonly mapping: ReadonlyMap<number, string>,
    private readonly budgetMiB: number | null, private readonly read: MemoryReader = readNvidiaMemory,
    private readonly report: (sample: DeviceMemorySample) => void = sample => console.error("CG_GPU_MEMORY " + JSON.stringify(sample))) {
    if (budgetMiB !== null && (!Number.isSafeInteger(budgetMiB) || budgetMiB <= 0)) throw new Error("GPU memory budget must be a positive MiB limit.");
  }

  sample(phase: MemoryPhase): void {
    const devices = this.read();
    for (const [adapter, uuid] of this.mapping) {
      const device = devices.find(item => item.uuid === uuid) ?? null;
      if (!device) throw new Error("Mapped GPU is unavailable: " + uuid);
      const baselineMiB = this.baseline.get(adapter) ?? device.usedMiB;
      const peakSampledMiB = Math.max(this.peaks.get(adapter) ?? baselineMiB, device.usedMiB);
      this.baseline.set(adapter, baselineMiB);
      this.peaks.set(adapter, peakSampledMiB);
      this.report({...device, adapter, phase, baselineMiB, peakSampledMiB});
      if (phase !== "after-exit" && this.budgetMiB !== null && device.usedMiB > this.budgetMiB) {
        throw new Error(`GPU ${adapter} exceeded the configured device memory budget: ${device.usedMiB} MiB > ${this.budgetMiB} MiB.`);
      }
    }
  }
}

export function configuredGpuMemoryMonitor(adapters: readonly number[]): GpuMemoryMonitor | null {
  const mapping = process.env.CODE_GUARDS_GPU_MEMORY_MAP ?? "";
  const budget = process.env.CODE_GUARDS_GPU_MEMORY_BUDGET_MIB ?? "";
  if (!mapping && !budget) return null;
  if (!mapping) throw new Error("GPU memory budgeting requires an explicit adapter UUID mapping.");
  return new GpuMemoryMonitor(parseMemoryMap(mapping, adapters), budget ? Number(budget) : null);
}
