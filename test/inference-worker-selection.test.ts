import { strict as assert } from "node:assert";
import { test } from "node:test";
import { leastPendingWorkerIndex } from "../src/inference-workers.ts";

test("worker assignment selects the least queued GPU", () => {
  assert.equal(leastPendingWorkerIndex([3, 1], 0), 1);
  assert.equal(leastPendingWorkerIndex([0, 4], 1), 0);
  assert.equal(leastPendingWorkerIndex([2], 0), 0);
});

test("worker assignment rotates ties fairly", () => {
  assert.equal(leastPendingWorkerIndex([1, 1], 0), 0);
  assert.equal(leastPendingWorkerIndex([1, 1], 1), 1);
  assert.equal(leastPendingWorkerIndex([2, 1, 1], 2), 2);
  assert.equal(leastPendingWorkerIndex([2, 1, 1], 1), 1);
});

test("worker assignment rejects missing and corrupt queue counts", () => {
  assert.throws(() => leastPendingWorkerIndex([], 0), /Invalid GPU/);
  assert.throws(() => leastPendingWorkerIndex([0, -1], 0), /Invalid GPU/);
  assert.throws(() => leastPendingWorkerIndex([0, Number.NaN], 0), /Invalid GPU/);
});
