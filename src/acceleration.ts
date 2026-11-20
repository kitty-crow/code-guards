/** Independent inference accelerations. Device choices are ordered alternatives. */
export type Acceleration = "cache" | "batch" | "cuda" | "webgpu";
export type AccelerationConfig = {
  features: ReadonlySet<Acceleration>;
  batchSize: number;
};
export const NO_ACCELERATION: AccelerationConfig = { features: new Set<Acceleration>(), batchSize: 4 };

export function parseAccelerationFlags(argv: readonly string[]): {
  remaining: string[];
  acceleration: AccelerationConfig;
} {
  const remaining: string[] = [];
  const features = new Set<Acceleration>();
  let batchSize = 4;
  let explicitBatch = false;
  let none = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const accel = arg === "--accelerate" || arg.startsWith("--accelerate=");
    const size = arg === "--batch-size" || arg.startsWith("--batch-size=");
    if (!accel && !size) { remaining.push(arg); continue; }
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i] ?? "";
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg.split("=")[0]);
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
      if (feature !== "cache" && feature !== "batch" && feature !== "cuda" && feature !== "webgpu") {
        throw new Error("Unsupported acceleration: " + feature);
      }
      features.add(feature);
    }
  }
  if (none && features.size) throw new Error("none cannot be combined with acceleration flags.");
  if (explicitBatch && !features.has("batch")) throw new Error("--batch-size requires --accelerate batch.");
  return { remaining, acceleration: { features, batchSize } };
}

export function accelerationNames(settings: AccelerationConfig): string[] {
  return settings.features.size ? [...settings.features] : ["none"];
}
