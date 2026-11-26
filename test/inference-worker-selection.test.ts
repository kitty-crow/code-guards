import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import type { AccelerationConfig } from "../src/acceleration.ts";
import { leastPendingWorkerIndex, createLazyWorkerPool, createNativeCpuWorkerPool, decodeSemanticQuestion } from "../src/inference-workers.ts";
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

const retryConfig: AccelerationConfig = {features: new Set(), batchSize: 4, concurrency: 2, gpuIds: []};
const retryQuestion = {premise: "same evidence", same: "same", different: "different"};
const replyScript = `
  const readline = require("node:readline");
  const gpuId = Number(process.env.CODE_GUARDS_GPU_WORKER_ID);
  readline.createInterface({input: process.stdin}).on("line", line => {
    const request = JSON.parse(line);
    if (request.question.premise !== "same evidence") process.exit(9);
    console.log(JSON.stringify({type: "result", gpuId, id: request.id, verdict: {
      sameConcept: 0.9, differentConcept: 0.1,
      evidence: {windows: 1, supportWindow: 1, oppositionWindow: 1}
    }}));
  });
`;

test("native abnormal exit replays outstanding requests on the same adapter", async () => {
  let launches = 0;
  const pool = createNativeCpuWorkerPool(retryConfig, () => {}, (_exe, _args, options) => {
    launches += 1;
    const script = launches === 1
      ? 'require("node:readline").createInterface({input: process.stdin}).once("line", () => process.exit(5));'
      : replyScript;
    return spawn(process.execPath, ["-e", script], options);
  });
  try {
    const results = await Promise.all([pool.score(retryQuestion), pool.score(retryQuestion)]);
    assert.deepEqual(results.map(result => result.sameConcept), [0.9, 0.9]);
    assert.equal(launches, 2);
    await pool.drainAndClose();
  } finally { pool.close(); }
});

test("repeated native exits exhaust the restart budget without accepting a partial verdict", async () => {
  let launches = 0;
  const pool = createNativeCpuWorkerPool(retryConfig, () => {}, (_exe, _args, options) => {
    launches += 1;
    return spawn(process.execPath, ["-e",
      'require("node:readline").createInterface({input: process.stdin}).once("line", () => process.exit(5));'], options);
  });
  try {
    await assert.rejects(pool.score(retryQuestion), /worker exited: 5/);
    assert.equal(launches, 3);
    await assert.rejects(pool.drainAndClose(), /worker exited: 5/);
  } finally { pool.close(); }
});

test("explicit fatal inference errors are never retried", async () => {
  let launches = 0;
  const pool = createNativeCpuWorkerPool(retryConfig, () => {}, (_exe, _args, options) => {
    launches += 1;
    return spawn(process.execPath, ["-e", `
      require("node:readline").createInterface({input: process.stdin}).once("line", () => {
        console.log(JSON.stringify({type: "fatal", gpuId: 0, message: "invalid evidence"}));
      });
    `], options);
  });
  try {
    await assert.rejects(pool.score(retryQuestion), /invalid evidence/);
    assert.equal(launches, 1);
  } finally { pool.close(); }
});
