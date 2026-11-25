import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assessWindows, MAX_MODEL_TOKENS, observeSemanticTimings, premiseWindows, premiseWindowCount, comparisonQuestion, semanticQuestionKey, supportsReuse, investigateComparison, type SemanticQuestion, type SemanticTimingEvent, type Classifier } from "../src/semantic.ts";

function fakeRuntime(assess: (window: string) => { same: number; different: number }) {
  const dictionary = new Map<string, number>();
  const reverse = new Map<number, string>();
  const tokenize = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);
  const tokenizer: Classifier["tokenizer"] = {
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
  const classify: Classifier = Object.assign(async (premise: string, labels: string[]) => {
    calls.push(premise);
    const verdict = assess(premise);
    return { labels, scores: [verdict.same, verdict.different] };
  }, { tokenizer, classifyBatch: null });
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


test("timing observations measure preparation and each inference without changing verdicts", async () => {
  const runtime = fakeRuntime(() => ({ same: 0.88, different: 0.04 }));
  const observed: SemanticTimingEvent[] = [];
  const restore = observeSemanticTimings(event => { observed.push(event); });
  try {
    const verdict = await assessWindows(question("Both interfaces contain equivalent fields."), runtime.classify);
    assert.equal(verdict.sameConcept, 0.88);
    assert.equal(verdict.differentConcept, 0.04);
    assert.deepEqual(observed.map(event => event.phase), ["windowing", "inference", "verdict"]);
    assert.ok(observed.every(event => Number.isFinite(event.milliseconds) && event.milliseconds >= 0));
    const first = observed[0] ?? null;
    assert.equal(first && first.phase === "windowing" ? first.windows : -1, 1);
    const second = observed[1] ?? null;
    assert.equal(second && second.phase === "inference" ? second.window : -1, 1);
  } finally {
    restore();
  }
});

test("paired windows preserve distant evidence from both compared entities", async () => {
  const left = Array.from(Array<number>(620).keys(), index => `left${index}`).join(" ");
  const right = Array.from(Array<number>(620).keys(), index => `right${index}`).join(" ");
  const runtime = fakeRuntime(window => window.includes("left0") && window.includes("right619")
    ? {same: 0.05, different: 0.96} : {same: 0.91, different: 0.04});
  const plain = question(left + " " + right);
  const paired = comparisonQuestion(plain, {name: "alpha", evidence: left}, {name: "beta", evidence: right});
  const windows = premiseWindows(paired, runtime.tokenizer);
  assert.equal(premiseWindowCount(paired, runtime.tokenizer), windows.length);
  assert.ok(windows.every(window => window.includes("First entity alpha:") && window.includes("Second entity beta:")));
  assert.ok(windows.some(window => window.includes("left0") && window.includes("right619")));
  assert.ok(windows.some(window => window.includes("left619") && window.includes("right0")));
  assert.notEqual(semanticQuestionKey(paired), semanticQuestionKey(plain));
  const verdict = await assessWindows(paired, runtime.classify);
  assert.ok(!supportsReuse(verdict));
});

test("adaptive investigation retains decisive verdicts and refines ambiguous comparisons", async () => {
  const question = comparisonQuestion({premise: "initial", same: "same", different: "different"},
    {name: "a", evidence: "left"}, {name: "b", evidence: "right"});
  const refinement = comparisonQuestion({premise: "complete declarations", same: "shared behaviour", different: "distinct behaviour"},
    {name: "a", evidence: "left including constraints"}, {name: "b", evidence: "right including constraints"});
  const options = {enabled: true, minimum: 0.78, context: "test", refine: () => refinement};
  const seen: string[] = [];
  const result = await investigateComparison(async item => {
    seen.push(item.premise);
    return item.premise === "initial" ? {sameConcept: 0.6, differentConcept: 0.6} : {sameConcept: 0.95, differentConcept: 0.05};
  }, question, options);
  assert.ok(supportsReuse(result));
  assert.deepEqual(seen, ["initial", "complete declarations"]);
  const decisive = await investigateComparison(async item => {
    assert.equal(item.premise, "initial");
    return {sameConcept: 0.05, differentConcept: 0.95};
  }, question, options);
  assert.ok(!supportsReuse(decisive));
});

test("missing or duplicate model labels fail instead of silently becoming zero scores", async () => {
  const runtime = fakeRuntime(() => ({same: 0.9, different: 0.1}));
  const bad: Classifier = Object.assign(async () => ({labels: ["wrong", "wrong"], scores: [0.9, 0.1]}),
    {tokenizer: runtime.tokenizer, classifyBatch: null});
  await assert.rejects(assessWindows(question("source evidence"), bad), /classification/);
  const missing: Classifier = Object.assign(async () => ({labels: ["wrong", question("source evidence").different], scores: [0.9, 0.1]}),
    {tokenizer: runtime.tokenizer, classifyBatch: null});
  await assert.rejects(assessWindows(question("source evidence"), missing), /hypothesis score/);
});

test("adaptive investigation honours the caller's opposing evidence limit", async () => {
  const initial = question("first");
  const refined = question("additional evidence");
  const seen: string[] = [];
  const verdict = await investigateComparison(async item => {
    seen.push(item.premise);
    return item.premise === "first" ? {sameConcept: 0.92, differentConcept: 0.5} : {sameConcept: 0.1, differentConcept: 0.93};
  }, initial, {enabled: true, minimum: 0.81, maximumOpposition: 0.35, context: "fixture", refine: () => refined});
  assert.deepEqual(seen, ["first", "additional evidence"]);
  assert.equal(verdict.differentConcept, 0.93);
});
