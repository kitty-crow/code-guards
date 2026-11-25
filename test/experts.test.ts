import { strict as assert } from "node:assert";
import { test } from "node:test";
import { guardCapabilities, expertCacheDirectory, ProseExpert, EmbeddingExpert, PROSE_EXPERT, type SourceEvidence, type EmbeddingRuntime } from "../src/experts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function passage(text: string, line: number): SourceEvidence {
  return {text, location: {file: "guide.md", line, column: 1}};
}

test("mechanical guards do not request model capabilities", () => {
  assert.deepEqual(guardCapabilities("no-nested-if"), ["compiler-facts"]);
  assert.ok(guardCapabilities("documentation").includes("prose-retrieval"));
  assert.ok(guardCapabilities("type-reuse").includes("semantic-judgement"));
  assert.ok(guardCapabilities("function-quality").includes("code-retrieval"));
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

test("persistent expert cache reuses unchanged inputs across sessions and isolates model revisions", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "guards-expert-cache-"));
  const profile = {...PROSE_EXPERT, dimensions: 2};
  let loads = 0;
  let encoded = 0;
  let disposed = 0;
  const load = async (): Promise<EmbeddingRuntime> => {
    loads += 1;
    return {embed: async inputs => {
      encoded += inputs.length;
      return inputs.map(text => text === "unrelated" ? [0, 1] : [1, 0]);
    }, dispose: async () => { disposed += 1; }};
  };
  const inputs = [passage("first", 1), passage("paraphrase", 2), passage("unrelated", 3)];
  try {
    const first = new EmbeddingExpert(profile, load, 2147483648, directory);
    const initial = await first.rank(inputs);
    await first.close();
    await first.close();
    assert.equal(disposed, 1);
    const warm = new EmbeddingExpert(profile, load, 2147483648, directory);
    assert.deepEqual(await warm.rank(inputs), initial);
    assert.equal(loads, 1);
    assert.equal(warm.metrics.persistentHits, 3);
    await warm.rank([passage("first", 1), passage("changed", 2), passage("unrelated", 3)]);
    assert.equal(encoded, 4);
    await warm.close();
    const revised = new EmbeddingExpert({...profile, revision: "different-revision"}, load, 2147483648, directory);
    await revised.rank(inputs);
    assert.equal(encoded, 7);
    assert.equal(revised.metrics.persistentHits, 0);
    await revised.close();
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test("configured experts use a persistent cache independently of source and Git snapshots", () => {
  const local = path.resolve("local-cache");
  const inference = path.resolve("inference-cache");
  assert.equal(expertCacheDirectory({CODE_GUARDS_EXPERT_CACHE_DIR: local, CODE_GUARDS_INFERENCE_CACHE_DIR: inference}), local);
  assert.equal(expertCacheDirectory({CODE_GUARDS_INFERENCE_CACHE_DIR: inference}), inference + ".experts");
  assert.equal(expertCacheDirectory({XDG_CACHE_HOME: local}), path.join(local, "code-guards", "experts"));
});

test("identical uncached expert inputs are encoded only once per batch", async () => {
  let encoded = 0;
  const expert = new ProseExpert(async () => ({
    embed: async inputs => { encoded += inputs.length; return inputs.map(() => [1, 0]); },
    dispose: async () => {}
  }));
  try {
    await expert.rank([passage("same", 1), passage("same", 2), passage("other", 3)]);
    assert.equal(encoded, 2);
    assert.equal(expert.metrics.encodedInputs, 2);
    assert.equal(expert.metrics.cacheHits, 1);
  } finally { await expert.close(); }
});

test("retrieval can shortlist multiple candidates for a code-to-documentation query", async () => {
  const expert = new ProseExpert(async () => ({
    embed: async inputs => inputs.map(text => text === "unrelated" ? [0, 1] : [1, 0]),
    dispose: async () => {}
  }));
  const inputs = [passage("first", 1), passage("second", 2), passage("unrelated", 3), passage("query", 4)];
  try {
    const result = await expert.search(inputs.slice(0, -1), inputs.slice(-1), 2);
    assert.deepEqual(result.matches.map(item => item.earlier.location.line), [1, 2]);
  } finally { await expert.close(); }
});
