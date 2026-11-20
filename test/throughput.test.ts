import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolve } from "node:path";
import { throughputOptions } from "../scripts/benchmark-throughput.ts";

test("throughput benchmark defaults to three independent, minute-long scans", () => {
  const options = throughputOptions(["--project", "tsconfig.json"]);
  assert.equal(options.project, resolve("tsconfig.json"));
  assert.equal(options.seconds, 60);
  assert.deepEqual(options.modes, ["none", "webgpu", "batch,webgpu"]);
  assert.equal(options.batchSize, 4);
  assert.equal(options.concurrency, 4);
  assert.equal(options.guard, "all");
});

test("throughput options support explicit acceleration, guard and diagnostic deadline", () => {
  const options = throughputOptions([
    "--project", "tsconfig.json", "--guard", "type-reuse",
    "--mode", "cache,batch,webgpu", "--mode", "none",
    "--batch-size", "8", "--concurrency", "6", "--seconds", "2"
  ]);
  assert.equal(options.seconds, 2);
  assert.equal(options.guard, "type-reuse");
  assert.equal(options.batchSize, 8);
  assert.equal(options.concurrency, 6);
  assert.deepEqual(options.modes, ["cache,batch,webgpu", "none"]);
});

test("throughput accepts dual Windows DirectML modes with explicit adapter IDs", () => {
  const result = throughputOptions([
    "--project", "tsconfig.json", "--mode", "dml", "--mode", "parallel,dml",
    "--gpu-ids", "0,1", "--concurrency", "4"
  ]);
  assert.deepEqual(result.modes, ["dml", "parallel,dml"]);
  assert.equal(result.gpuIds, "0,1");
});

test("throughput supports separate native WebGPU adapters", () => {
  const result = throughputOptions([
    "--project", "tsconfig.json", "--mode", "webgpu",
    "--mode", "parallel,webgpu", "--gpu-ids", "0,1", "--concurrency", "4"
  ]);
  assert.equal(result.gpuIds, "0,1");
  assert.deepEqual(result.modes, ["webgpu", "parallel,webgpu"]);
});

test("throughput rejects invalid modes, bounds and non-existent projects", () => {
  assert.throws(() => throughputOptions(["--project", "tsconfig.json", "--mode", "none,cuda"]), /cannot be combined/);
  assert.throws(() => throughputOptions(["--project", "tsconfig.json", "--seconds", "0"]), /--seconds/);
  assert.throws(() => throughputOptions(["--project", "tsconfig.json", "--batch-size", "17"]), /--batch-size/);
  assert.throws(() => throughputOptions(["--project", "tsconfig.json", "--guard", "not-a-guard"]), /Unknown guard/);
  assert.throws(() => throughputOptions(["--project", "tsconfig-nonexistent-123.json"]), /existing TensorFlow tsconfig/);
});
