import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";
import { afterEach, test } from "node:test";
import { options } from "../src/cli.ts";
import { parseAccelerationFlags } from "../src/acceleration.ts";
import { estimateInference, InferenceCounter } from "../src/preflight.ts";
import { premiseWindowCount, premiseWindows, type SemanticQuestion, type Tokenizer } from "../src/semantic.ts";
import { writeFixture } from "./fixture.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Exact deterministic test tokenizer, injected so tests never fetch model assets. */
function testTokenizer(): Tokenizer {
  const tokens = new Map<string, number>();
  const reverse = new Map<number, string>();
  return {
    encode: (value: string) => value.split(/\s+/).filter(Boolean).map(word => {
      const known = tokens.get(word) ?? null;
      if (known !== null) return known;
      const id = tokens.size + 1;
      tokens.set(word, id);
      reverse.set(id, word);
      return id;
    }),
    decode: ids => ids.map(id => reverse.get(id) ?? "").join(" ")
  };
}

const question = (premise: string): SemanticQuestion => ({
  premise,
  same: "the first item represents the same concept",
  different: "the items are different concepts"
});

function fixture(files: Record<string, string>): string {
  return writeFixture({
    ...files,
    "tsconfig.json": JSON.stringify({
      compilerOptions: {strict: true, noEmit: true},
      include: ["src/**/*.ts"]
    })
  }, cleanup, "code-guards-preflight-");
}

test("preflight CLI accepts user acceleration syntax without starting inference", () => {
  const configured = options([
    "all", "--project", "tsconfig.code-guards.json", "--preflight", "--include-tests",
    "--accelerate", "batch,parallel,webgpu", "--gpu-ids", "0,1",
    "--concurrency", "4", "--batch-size", "4", "--format", "json"
  ]);
  assert.equal(configured.preflight, true);
  assert.equal(configured.project, "tsconfig.code-guards.json");
  assert.equal(configured.format, "json");
  assert.equal(configured.acceleration.batchSize, 4);
  assert.deepEqual(configured.acceleration.gpuIds, [0, 1]);
});

test("preflight exact token windows share the real inference window plan", () => {
  const tokenizer = testTokenizer();
  for (const length of [0, 1, 20, 450, 500, 512, 695, 1200]) {
    const premise = Array.from(Array<number>(length).keys(), i => "word" + i).join(" ");
    const item = question(premise);
    assert.equal(premiseWindowCount(item, tokenizer), premiseWindows(item, tokenizer).length);
  }
});

test("type reuse excludes exact fingerprint matches and rejects filtered pairs", async () => {
  const root = fixture({
    "src/a.ts": "export interface Customer { name: string; email: string }",
    "src/b.ts": "export interface Client { fullName: string; emailAddress: string }",
    "src/c.ts": "export interface CustomerAlias { email: string; name: string }"
  });
  const config = {
    project: root,
    includeTests: true,
    enabled: new Set(["type-reuse"] as const)
  };
  const result = await estimateInference(config, parseAccelerationFlags([]).acceleration, testTokenizer());
  assert.equal(result.mode, "preflight");
  assert.equal(result.stages.length, 1);
  assert.ok(result.minimum.questions >= 1);
  assert.equal(result.maximum.questions, result.minimum.questions);
  assert.equal(result.minimum.windows, result.minimum.inferenceQuestions);
  assert.equal(result.minimum.modelCallsMinimum, result.minimum.windows);
  assert.equal(result.exactQuestionCount, true);
});

test("exact type matches do not invoke the neural model in preflight", async () => {
  const root = fixture({
    "src/one.ts": "export interface ExactA { name: string; id: number }",
    "src/two.ts": "export type ExactB = { id: number; name: string }"
  });
  const result = await estimateInference({
    project: root, includeTests: true,
    enabled: new Set(["type-reuse"] as const)
  }, parseAccelerationFlags([]).acceleration, testTokenizer());
  assert.equal(result.maximum.questions, 0);
  assert.equal(result.maximum.windows, 0);
});

test("documentation bounds account for handover-dependent README style questions", async () => {
  const root = fixture({
    "src/index.ts": "export const product = 1;",
    "README.md": [
      "# Example",
      "",
      "This introduction explains the current project and its purpose for readers with technical constraints and examples.",
      "",
      "The application has a clear API and returns documented outputs that readers can verify using the included commands.",
      "",
      "A further paragraph describes detailed deployment constraints and presents a concrete operation without needless history."
    ].join("\n")
  });
  const { acceleration } = parseAccelerationFlags([
    "--accelerate", "batch,parallel,webgpu", "--gpu-ids", "0,1",
    "--concurrency", "4", "--batch-size", "4"
  ]);
  const result = await estimateInference({
    project: root, includeTests: true,
    enabled: new Set(["documentation"] as const)
  }, acceleration, testTokenizer());
  assert.equal(result.stages.length, 1);
  assert.ok(result.minimum.questions > 0);
  assert.ok(result.maximum.questions > result.minimum.questions);
  assert.equal(result.exactQuestionCount, false);
  assert.ok(result.maximum.windows >= result.minimum.windows);
  assert.equal((result.calibration ?? "").includes("3,372"), true);
  assert.equal(result.gpuIds.length, 2);
  assert.equal(result.estimatedWarmInferenceSeconds !== null, true);
});

test("batching estimates compatible calls without conflating different hypotheses", async () => {
  const tokenizer = testTokenizer();
  const { acceleration } = parseAccelerationFlags([
    "--accelerate", "batch,parallel", "--batch-size", "4", "--concurrency", "4"
  ]);
  const counter = new InferenceCounter(tokenizer, acceleration);
  await counter.reject(question("first small passage"));
  await counter.reject(question("second small passage"));
  const result = counter.snapshot();
  assert.equal(result.questions, 2);
  assert.equal(result.windows, 2);
  assert.equal(result.modelCallsMinimum, 1);
  assert.equal(result.modelCallsMaximum, 2);
});

test("cache counts identical semantic questions without duplicate inference", async () => {
  const { acceleration } = parseAccelerationFlags(["--accelerate", "cache,batch"]);
  const counter = new InferenceCounter(testTokenizer(), acceleration);
  await counter.reject(question("some reusable evidence"));
  await counter.reject(question("some reusable evidence"));
  const result = counter.snapshot();
  assert.equal(result.questions, 2);
  assert.equal(result.inferenceQuestions, 1);
  assert.equal(result.cacheHits, 1);
  assert.equal(result.windows, 1);
});

test("disabled neural guards do not submit any semantic questions", async () => {
  const root = fixture({"src/main.ts": "export const value = 42;"});
  const result = await estimateInference({
    project: root, includeTests: true, enabled: new Set(["no-nested-if"] as const)
  }, parseAccelerationFlags([]).acceleration, testTokenizer());
  assert.deepEqual(result.stages, []);
  assert.equal(result.maximum.windows, 0);
  assert.equal(result.maximum.modelCallsMaximum, 0);
});

test("explicit native WebGPU cache requires both directory and a remote for syncing", () => {
  const base = ["all", "--accelerate", "batch,parallel,webgpu", "--gpu-ids", "0,1",
    "--concurrency", "4", "--batch-size", "4"];
  assert.throws(() => options([...base, "--sync-inference-cache"]), /requires/);
  const local = options([...base, "--inference-cache-dir", "C:\\cache"]);
  assert.equal(local.inferenceCacheDir, "C:\\cache");
  assert.equal(local.syncInferenceCache, false);
  const remote = options([...base, "--inference-cache-dir", "C:\\cache",
    "--cache-remote", "https://github.com/kitty-crow/tensorflow-ts.git",
    "--sync-inference-cache"]);
  assert.equal(remote.syncInferenceCache, true);
  assert.equal(remote.cacheRemote, "https://github.com/kitty-crow/tensorflow-ts.git");
});
