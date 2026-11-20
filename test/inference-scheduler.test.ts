import { strict as assert } from "node:assert";
import { test } from "node:test";
import { orderedConcurrentMap } from "../src/inference-scheduler.ts";
import { configureSemanticAcceleration, semanticConcurrency } from "../src/semantic.ts";
import { parseAccelerationFlags } from "../src/acceleration.ts";

test("parallel worker pool preserves input order and bounds in-flight work", async () => {
  const input = Array.from({ length: 12 }, (_, index) => index);
  let active = 0;
  let peak = 0;
  const output = await orderedConcurrentMap(input, 3, async value => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => setTimeout(resolve, (12 - value) % 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(output, input.map(value => value * 2));
  assert.equal(peak, 3);
});

test("concurrency defaults to serial and must be explicitly enabled", () => {
  assert.equal(semanticConcurrency(), 1);
  const restore = configureSemanticAcceleration(
    parseAccelerationFlags(["--accelerate", "parallel", "--concurrency", "4"]).acceleration
  );
  try { assert.equal(semanticConcurrency(), 4); }
  finally { restore(); }
  assert.equal(semanticConcurrency(), 1);
});

test("worker pool rejects invalid bounds and stops scheduling after a failure", async () => {
  await assert.rejects(orderedConcurrentMap([1], 0, async value => value), /between 1 and 16/);
  await assert.rejects(orderedConcurrentMap([1, 2, 3, 4], 2, async value => {
    if (value === 2) throw new Error("intentional failure");
    return value;
  }), /intentional failure/);
});
