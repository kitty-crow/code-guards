#!/usr/bin/env bun
/** Probe two physical WebGPU adapters before running the full TensorFlow scan. */
import { createGpuWorkerPool } from "../src/inference-workers.ts";
import { parseAccelerationFlags } from "../src/acceleration.ts";

const { acceleration, remaining } = parseAccelerationFlags([
  "--accelerate", "parallel,webgpu", "--concurrency", "2", "--gpu-ids", "0,1"
]);
if (remaining.length || !acceleration.gpuIds) throw new Error("Invalid dual-WebGPU probe configuration.");
const loaded = new Set<number>();
const pool = createGpuWorkerPool(acceleration.gpuIds, acceleration, event => {
  if (event.type === "loading") console.error("[Code Guards] WebGPU adapter " + event.gpuId + ": loading model");
  if (event.type === "ready") {
    loaded.add(event.gpuId);
    console.error("[Code Guards] WebGPU adapter " + event.gpuId + ": model ready");
  }
});
const question = {
  premise: "Two TypeScript interfaces have identical property contracts.",
  same: "the interfaces represent the same reusable concept",
  different: "the interfaces represent different concepts"
};
try {
  const answers = await Promise.all([pool.score(question), pool.score(question)]);
  if (loaded.size !== 2) throw new Error("Both adapters were not confirmed ready.");
  console.log(JSON.stringify({
    adapters: [...loaded].sort((a, b) => a - b),
    results: answers
  }, null, 2));
} catch (error) {
  console.error("[Code Guards] Dual-WebGPU probe failed: " +
    (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  pool.close();
}
