import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GpuMemoryMonitor, parseMemoryMap, type DeviceMemorySample } from "../src/gpu-memory.ts";

test("GPU memory requires verified unique UUID mappings instead of assuming ordinal identity", () => {
  assert.deepEqual([...parseMemoryMap("0=GPU-a1,1=GPU-b2", [0, 1])], [[0, "GPU-a1"], [1, "GPU-b2"]]);
  assert.throws(() => parseMemoryMap("0=GPU-a1", [0, 1]), /cover every/);
  assert.throws(() => parseMemoryMap("0=GPU-a1,1=GPU-a1", [0, 1]), /duplicate/);
});

test("GPU memory monitor retains measured baseline, peak and post-exit readings", () => {
  let used = 100;
  const samples: DeviceMemorySample[] = [];
  const monitor = new GpuMemoryMonitor(parseMemoryMap("0=GPU-a1", [0]), 1000,
    () => [{uuid: "GPU-a1", usedMiB: used, totalMiB: 4096}], sample => {samples.push(sample);});
  monitor.sample("before-load");
  used = 750;
  monitor.sample("active");
  used = 1100;
  assert.throws(() => monitor.sample("active"), /exceeded/);
  used = 120;
  monitor.sample("after-exit");
  const last = samples.at(-1) ?? null;
  assert.ok(last);
  assert.equal(last.usedMiB, 120);
  assert.equal(last.baselineMiB, 100);
  assert.equal(last.peakSampledMiB, 1100);
  assert.equal(last.phase, "after-exit");
});
