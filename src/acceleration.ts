/** Independent inference accelerations. Device choices are ordered alternatives. */
export type Acceleration = "cache" | "batch" | "parallel" | "cuda" | "dml" | "webgpu";
export type AccelerationConfig = {
  features: ReadonlySet<Acceleration>;
  batchSize: number;
  concurrency: number;
  gpuIds: readonly number[];
};
export const NO_ACCELERATION: AccelerationConfig = { features: new Set<Acceleration>(), batchSize: 4, concurrency: 1, gpuIds: [] };

function parseGpuIds(value: string): number[] {
  const ids = value.split(",").map(part => part.trim() ? Number(part) : NaN);
  if (ids.length < 1 || ids.length > 16 || new Set(ids).size !== ids.length ||
      ids.some(id => !Number.isSafeInteger(id) || id < 0 || id > 15)) {
    throw new Error("--gpu-ids requires 1 to 16 unique GPU indices from 0 to 15.");
  }
  return ids;
}

function parseSize(value: string, flag: string): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 2 || size > 16) {
    throw new Error(flag + " must be an integer from 2 to 16.");
  }
  return size;
}

// Read each accelerator option once; preserve the order of other CLI flags.
export function parseAccelerationFlags(argv: readonly string[]): {
  remaining: string[];
  acceleration: AccelerationConfig;
} {
  const remaining: string[] = [];
  const features = new Set<Acceleration>();
  let batchSize = 4;
  let concurrency = 1;
  let explicitBatch = false;
  let explicitConcurrency = false;
  let gpuIds: number[] = [];
  let none = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const accel = arg === "--accelerate" || arg.startsWith("--accelerate=");
    const size = arg === "--batch-size" || arg.startsWith("--batch-size=");
    const workers = arg === "--concurrency" || arg.startsWith("--concurrency=");
    const gpu = arg === "--gpu-ids" || arg.startsWith("--gpu-ids=");
    if (!accel && !size && !workers && !gpu) { remaining.push(arg); continue; }
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i] ?? "";
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + (arg.split("=")[0] ?? arg));
    if (gpu) {
      gpuIds = parseGpuIds(value);
      continue;
    }
    if (workers) {
      concurrency = parseSize(value, "--concurrency");
      explicitConcurrency = true;
      continue;
    }
    if (size) {
      batchSize = parseSize(value, "--batch-size");
      explicitBatch = true;
      continue;
    }
    for (const item of value.split(",")) {
      const feature = item.trim().toLowerCase();
      if (feature === "none") { none = true; continue; }
      if (feature !== "cache" && feature !== "batch" && feature !== "parallel" &&
          feature !== "cuda" && feature !== "dml" && feature !== "webgpu") {
        throw new Error("Unsupported acceleration: " + feature);
      }
      features.add(feature);
    }
  }
  if (none && features.size) throw new Error("none cannot be combined with acceleration flags.");
  if (explicitBatch && !features.has("batch")) throw new Error("--batch-size requires --accelerate batch.");
  if (explicitConcurrency && !features.has("parallel")) {
    throw new Error("--concurrency requires --accelerate parallel.");
  }
  if (gpuIds.length && (!features.has("parallel") ||
      Number(features.has("cuda")) + Number(features.has("dml")) + Number(features.has("webgpu")) !== 1)) {
    throw new Error("--gpu-ids requires parallel plus exactly one GPU backend: cuda, dml or webgpu.");
  }
  if (gpuIds.length && concurrency < gpuIds.length) {
    throw new Error("--concurrency must be at least the number of selected GPUs.");
  }
  return { remaining, acceleration: { features, batchSize, concurrency, gpuIds } };
}

export function accelerationNames(settings: AccelerationConfig): string[] {
  return settings.features.size ? [...settings.features] : ["none"];
}
