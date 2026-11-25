import { strict as assert } from "node:assert";
import { test } from "node:test";
import { leastPendingWorkerIndex, createLazyWorkerPool, decodeSemanticQuestion } from "../src/inference-workers.ts";
import { parseRecord } from "../src/json.ts";
import { comparisonQuestion } from "../src/semantic.ts";

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

test("unused worker pools never allocate a native model session", async () => {
  const pool = createLazyWorkerPool(() => { throw new Error("Unexpected allocation"); });
  await pool.drainAndClose();
  await assert.rejects(pool.score({premise: "a", same: "b", different: "c"}), /closed/);
});

test("lazy worker pool forwards paired evidence and drains allocated workers", async () => {
  let allocated = 0;
  let drained = 0;
  const question = comparisonQuestion({premise: "two entities", same: "same", different: "different"},
    {name: "left", evidence: "beginning"}, {name: "right", evidence: "tail"});
  const pool = createLazyWorkerPool(() => {
    allocated += 1;
    return {
      score: async received => {
        assert.deepEqual(received, question);
        return {sameConcept: 0.9, differentConcept: 0.1, evidence: {windows: 1, supportWindow: 1, oppositionWindow: 1}};
      },
      close: () => {},
      drainAndClose: async () => { drained += 1; }
    };
  });
  assert.equal(allocated, 0);
  await pool.score(question);
  await pool.score(question);
  await pool.drainAndClose();
  assert.equal(allocated, 1);
  assert.equal(drained, 1);
  assert.deepEqual(decodeSemanticQuestion(parseRecord(JSON.stringify(question))), question);
  assert.throws(() => decodeSemanticQuestion(parseRecord('{"premise":"p","same":"s","different":"d","comparison":true}')), /paired/);
});
