#!/usr/bin/env bun
/** Probe two physical WebGPU adapters before running a project scan. */
import { createGpuWorkerPool } from "../src/inference-workers.ts";
import { parseAccelerationFlags } from "../src/acceleration.ts";

const { acceleration, remaining } = parseAccelerationFlags([
  "--accelerate", "parallel,webgpu", "--concurrency", "2", "--gpu-ids", "0,1"
]);
if (remaining.length || !acceleration.gpuIds.length) throw new Error("Invalid dual-WebGPU probe configuration.");
const loaded = new Set<number>();
const proofs = new Map<number, {
  gpuNodes: number; cpuNodes: number; gpuOps: string[];
  gpuTimeMs: number; cpuTimeMs: number;
}>();
const pool = createGpuWorkerPool(acceleration.gpuIds, acceleration, event => {
  if (event.type === "loading") console.error("[Code Guards] WebGPU adapter " + event.gpuId + ": loading model");
  if (event.type === "ready") {
    loaded.add(event.gpuId);
    console.error("[Code Guards] WebGPU adapter " + event.gpuId + ": model ready");
  }
  if (event.type === "timing" && event.timing.phase === "provider-proof") {
    proofs.set(event.gpuId, {
      gpuNodes: event.timing.gpuNodes, cpuNodes: event.timing.cpuNodes,
      gpuOps: event.timing.gpuOps,
      gpuTimeMs: event.timing.gpuTimeMs, cpuTimeMs: event.timing.cpuTimeMs
    });
    console.error("[Code Guards] WebGPU adapter " + event.gpuId +
      ": executed " + event.timing.gpuNodes + " WebGPU nodes and " +
      event.timing.cpuNodes + " CPU nodes");
  }
});
const question = {
  premise: "Two TypeScript interfaces have identical property contracts.",
  same: "the interfaces represent the same reusable concept",
  different: "the interfaces represent different concepts"
};
try {
  const answers = await Promise.all([pool.score(question), pool.score(question)]);
  if (loaded.size !== 2 || proofs.size !== 2) {
    throw new Error("Both adapters must confirm actual WebGPU inference.");
  }
  console.log(JSON.stringify({
    adapters: [...loaded].sort((a, b) => a - b),
    providerProofs: Object.fromEntries(proofs),
    results: answers
  }, null, 2));
} catch (error) {
  console.error("[Code Guards] Dual-WebGPU probe failed: " +
    (error instanceof Error ? error.message : typeof error === "string" ? error : "Probe failed"));
  process.exitCode = 1;
} finally {
  pool.close();
}
