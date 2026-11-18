import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assessWindows, MAX_MODEL_TOKENS, premiseWindows, supportsReuse, type SemanticQuestion } from "../src/semantic.ts";

type Runtime = Parameters<typeof assessWindows>[1];

function fakeRuntime(assess: (window: string) => { same: number; different: number }) {
  const dictionary = new Map<string, number>();
  const reverse = new Map<number, string>();
  const tokenize = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);
  const tokenizer: Runtime["tokenizer"] = {
    encode: text => tokenize(text).map(word => {
      const known = dictionary.get(word) ?? null;
      if (known !== null) return known;
      const id = dictionary.size + 1;
      dictionary.set(word, id);
      reverse.set(id, word);
      return id;
    }),
    decode: ids => ids.map(id => reverse.get(id) ?? "").join(" ")
  };
  const calls: string[] = [];
  const classify: Runtime = Object.assign(async (premise: string, labels: string[]) => {
    calls.push(premise);
    const verdict = assess(premise);
    return { labels, scores: [verdict.same, verdict.different] };
  }, { tokenizer });
  return { classify, tokenizer, calls };
}

const question = (premise: string): SemanticQuestion => ({
  premise,
  same: "the declarations should share a reusable domain type",
  different: "the declarations have distinct contracts and must remain separate"
});

test("695-token premise is split into overlapping windows within the full model token budget", async () => {
  const runtime = fakeRuntime(() => ({ same: 0.88, different: 0.02 }));
  const premise = Array.from(Array<number>(695).keys(), index => `word${index}`).join(" ");
  const windows = premiseWindows(question(premise), runtime.tokenizer);
  assert.ok(windows.length >= 2);
  assert.match(windows[0] ?? "", /word0/);
  assert.match(windows.at(-1) ?? "", /word694/);
  const covered = new Set(windows.join(" ").split(/\s+/));
  assert.equal(covered.size, 695, "no premise tokens may disappear");
  for (const window of windows) {
    const labelTokens = Math.max(...[question(premise).same, question(premise).different].map(label => runtime.tokenizer.encode(`The evidence indicates that ${label}.`, { add_special_tokens: false }).length));
    assert.ok(runtime.tokenizer.encode(window, { add_special_tokens: false }).length + labelTokens + 3 <= MAX_MODEL_TOKENS);
  }
  const verdict = await assessWindows(question(premise), runtime.classify);
  assert.equal(verdict.evidence.windows, windows.length);
  assert.equal(runtime.calls.length, windows.length);
});

test("short premises are evaluated once without modifying their content", async () => {
  const runtime = fakeRuntime(() => ({ same: 0.91, different: 0.01 }));
  const verdict = await assessWindows(question("Two interfaces describe a client record."), runtime.classify);
  assert.deepEqual(runtime.calls, ["Two interfaces describe a client record."]);
  assert.equal(verdict.evidence.windows, 1);
  assert.ok(supportsReuse(verdict));
});

test("contradictory evidence in another window prevents an unsupported reuse warning", async () => {
  const runtime = fakeRuntime(text => text.includes("counterexample") ?
    { same: 0.03, different: 0.96 } : { same: 0.93, different: 0.04 });
  const premise = [...Array.from(Array<number>(620).keys(), i => `evidence${i}`), "counterexample"].join(" ");
  const verdict = await assessWindows(question(premise), runtime.classify);
  assert.ok(verdict.evidence.windows > 1);
  assert.ok(verdict.sameConcept > 0.9);
  assert.ok(verdict.differentConcept > 0.9);
  assert.equal(supportsReuse(verdict), false);
});

test("overlength hypotheses fail explicitly instead of silently truncating labels", () => {
  const runtime = fakeRuntime(() => ({ same: 1, different: 0 }));
  assert.throws(() => premiseWindows({ premise: "text", same: "phrase ".repeat(510), different: "short" }, runtime.tokenizer), /hypothesis is too long/);
});
