import { strict as assert } from "node:assert";
import { test } from "node:test";
import { guardCapabilities, ProseExpert, type SourceEvidence, type EmbeddingRuntime } from "../src/experts.ts";

function passage(text: string, line: number): SourceEvidence {
  return {text, location: {file: "guide.md", line, column: 1}};
}

test("mechanical guards do not request model capabilities", () => {
  assert.deepEqual(guardCapabilities("no-nested-if"), ["compiler-facts"]);
  assert.ok(guardCapabilities("documentation").includes("prose-retrieval"));
  assert.ok(guardCapabilities("type-reuse").includes("semantic-judgement"));
});

test("prose retrieval loads lazily, ranks evidence and reuses completed embeddings", async () => {
  let loads = 0;
  let disposals = 0;
  const runtime: EmbeddingRuntime = {
    embed: async inputs => inputs.map(text => text === "long" ? null : text === "unrelated" ? [0, 1] : [1, 0]),
    dispose: async () => { disposals += 1; }
  };
  const expert = new ProseExpert(async () => { loads += 1; return runtime; });
  const inputs = [passage("first", 1), passage("unrelated", 3), passage("paraphrase", 5), passage("long", 7)];
  try {
    assert.equal(loads, 0);
    const first = await expert.rank(inputs);
    const second = await expert.rank(inputs);
    assert.deepEqual(second, first);
    assert.equal(loads, 1);
    assert.equal(expert.metrics.batches, 1);
    assert.equal(expert.metrics.cacheHits, inputs.length);
    assert.deepEqual(first.matches.map(item => [item.earlier.location.line, item.later.location.line]), [[1, 5]]);
    assert.deepEqual(first.unresolved.map(item => item.location.line), [7]);
  } finally { await expert.close(); }
  assert.equal(disposals, 1);
  await assert.rejects(expert.rank(inputs), /closed/);
});

test("prose expert releases an allocated runtime when inference fails", async () => {
  let disposals = 0;
  const expert = new ProseExpert(async () => ({
    embed: async () => { throw new Error("inference failed"); },
    dispose: async () => { disposals += 1; }
  }));
  try {
    await assert.rejects(expert.rank([passage("one", 1), passage("two", 2)]), /inference failed/);
  } finally { await expert.close(); }
  assert.equal(disposals, 1);
});
