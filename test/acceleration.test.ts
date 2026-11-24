import { strict as assert } from "node:assert";
import { test } from "node:test";
import { accelerationNames, parseAccelerationFlags } from "../src/acceleration.ts";
import { assessWindows } from "../src/semantic.ts";

test("acceleration flags combine, repeat, disable and reject invalid combinations", () => {
  const selected = parseAccelerationFlags(["--strict", "--accelerate", "cache,batch", "--accelerate=webgpu", "--batch-size", "8"]);
  assert.deepEqual(selected.remaining, ["--strict"]);
  assert.deepEqual(accelerationNames(selected.acceleration), ["cache", "batch", "webgpu"]);
  assert.equal(selected.acceleration.batchSize, 8);
  assert.deepEqual(accelerationNames(parseAccelerationFlags([]).acceleration), ["none"]);
  assert.deepEqual(accelerationNames(parseAccelerationFlags(["--accelerate", "none"]).acceleration), ["none"]);
  assert.throws(() => parseAccelerationFlags(["--accelerate", "none,cuda"]), /cannot be combined/);
  assert.throws(() => parseAccelerationFlags(["--batch-size", "4"]), /requires/);
  assert.throws(() => parseAccelerationFlags(["--concurrency", "4"]), /requires/);
  assert.equal(parseAccelerationFlags(["--accelerate", "parallel,webgpu", "--concurrency", "4"]).acceleration.concurrency, 4);
  assert.deepEqual(parseAccelerationFlags([
    "--accelerate", "parallel,cuda", "--concurrency", "2", "--gpu-ids", "0,1"
  ]).acceleration.gpuIds, [0, 1]);
  assert.throws(() => parseAccelerationFlags([
    "--accelerate", "parallel,webgpu,cuda", "--concurrency", "2", "--gpu-ids", "0,1"
  ]), /requires/);
  assert.throws(() => parseAccelerationFlags([
    "--accelerate", "parallel,cuda", "--concurrency", "2", "--gpu-ids", "0,0"
  ]), /unique/);
  assert.deepEqual(parseAccelerationFlags([
    "--accelerate", "parallel,dml", "--concurrency", "2", "--gpu-ids", "0,1"
  ]).acceleration.gpuIds, [0, 1]);
  assert.deepEqual(parseAccelerationFlags([
    "--accelerate", "parallel,webgpu", "--concurrency", "2", "--gpu-ids", "0,1"
  ]).acceleration.gpuIds, [0, 1]);
  assert.deepEqual(parseAccelerationFlags([
    "--accelerate", "batch,parallel,webgpu", "--batch-size", "4",
    "--concurrency", "4", "--gpu-ids", "0"
  ]).acceleration.gpuIds, [0]);
  assert.throws(() => parseAccelerationFlags([
    "--accelerate", "parallel,cuda,dml", "--concurrency", "2", "--gpu-ids", "0,1"
  ]), /requires/);
  assert.throws(() => parseAccelerationFlags(["--accelerate", "incorrect"]), /Unsupported acceleration/);
});

test("batch execution preserves contradictory evidence across multiple windows", async () => {
  const dictionary = new Map<string, number>();
  const reverse = new Map<number, string>();
  const tokenize = (text: string): number[] => text.split(/\s+/).filter(Boolean).map(word => {
    let id = dictionary.get(word) ?? null;
    if (id === null) {
      id = dictionary.size + 1;
      dictionary.set(word, id);
      reverse.set(id, word);
    }
    return id;
  });
  const classify = (text: string, labels: string[]) => ({
    labels, scores: text.includes("counterexample") ? [0.03, 0.97] : [0.96, 0.02]
  });
  const batches: number[] = [];
  const runtime = Object.assign(async (text: string, labels: string[]) => classify(text, labels), {
    tokenizer: {
      encode: (text: string) => tokenize(text),
      decode: (ids: number[]) => ids.map(id => reverse.get(id) ?? "").join(" ")
    },
    classifyBatch: async (texts: string[], labels: string[]) => {
      batches.push(texts.length);
      return texts.map(text => classify(text, labels));
    }
  });
  const premise = [...Array.from(Array<number>(600).keys(), index => "text" + index), "counterexample"].join(" ");
  const verdict = await assessWindows({ premise, same: "same concept", different: "different concept" }, runtime, 2);
  assert.ok(batches.length > 0);
  assert.ok(verdict.evidence.windows > 1);
  assert.ok(verdict.sameConcept > 0.9);
  assert.ok(verdict.differentConcept > 0.9);
  assert.ok(verdict.evidence.oppositionWindow > 1);
});
