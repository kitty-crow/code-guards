/** Independent inference accelerations. Device choices are ordered alternatives. */
export type Acceleration = "cache" | "batch" | "parallel" | "cuda" | "webgpu";
export type AccelerationConfig = {
  features: ReadonlySet<Acceleration>;
  batchSize: number;
  concurrency?: number;
  gpuIds?: readonly number[];
};
export const NO_ACCELERATION: AccelerationConfig = { features: new Set<Acceleration>(), batchSize: 4 };

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
  let gpuIds: number[] | undefined;
  let none = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const accel = arg === "--accelerate" || arg.startsWith("--accelerate=");
    const size = arg === "--batch-size" || arg.startsWith("--batch-size=");
    const workers = arg === "--concurrency" || arg.startsWith("--concurrency=");
    const gpu = arg === "--gpu-ids" || arg.startsWith("--gpu-ids=");
    if (!accel && !size && !workers && !gpu) { remaining.push(arg); continue; }
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i] ?? "";
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg.split("=")[0]);
    if (gpu) {
      const parts = value.split(",");
      gpuIds = parts.map(part => Number(part));
      if (gpuIds.length < 2 || gpuIds.length > 16 || new Set(gpuIds).size !== gpuIds.length ||
          gpuIds.some(id => !Number.isSafeInteger(id) || id < 0 || id > 15)) {
        throw new Error("--gpu-ids requires 2 to 16 unique GPU indices from 0 to 15.");
      }
      continue;
    }
    if (workers) {
      concurrency = Number(value);
      explicitConcurrency = true;
      if (!Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 16) {
        throw new Error("--concurrency must be an integer from 2 to 16.");
      }
      continue;
    }
    if (size) {
      batchSize = Number(value);
      explicitBatch = true;
      if (!Number.isSafeInteger(batchSize) || batchSize < 2 || batchSize > 16) {
        throw new Error("--batch-size must be an integer from 2 to 16.");
      }
      continue;
    }
    for (const item of value.split(",")) {
      const feature = item.trim().toLowerCase();
      if (feature === "none") { none = true; continue; }
      if (feature !== "cache" && feature !== "batch" && feature !== "parallel" &&
          feature !== "cuda" && feature !== "webgpu") {
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
  if (gpuIds && (!features.has("parallel") || !features.has("cuda") || features.has("webgpu"))) {
    throw new Error("--gpu-ids requires --accelerate parallel,cuda without webgpu.");
  }
  if (gpuIds && concurrency < gpuIds.length) {
    throw new Error("--concurrency must be at least the number of selected GPUs.");
  }
  return { remaining, acceleration: { features, batchSize, concurrency, ...(gpuIds ? { gpuIds } : {}) } };
}

export function accelerationNames(settings: AccelerationConfig): string[] {
  return settings.features.size ? [...settings.features] : ["none"];
}
