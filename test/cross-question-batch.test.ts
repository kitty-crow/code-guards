import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assessWindows, createQuestionBatcher, observeSemanticTimings,
  supportsReuse, type SemanticQuestion, type SemanticTimingEvent, type Classifier, type WindowVerdict
} from "../src/semantic.ts";

function runtime(): { classifier: Classifier; calls: string[][] } {
  const ids = new Map<string, number>();
  const words = new Map<number, string>();
  const tokens = (text: string): number[] => text.trim().split(/\s+/).filter(Boolean).map(word => {
    const previous = ids.get(word) ?? null;
    if (previous !== null) return previous;
    const number = ids.size + 1;
    ids.set(word, number);
    words.set(number, word);
    return number;
  });
  const calls: string[][] = [];
  const evaluate = (text: string, labels: string[]) => ({
    labels,
    scores: text.includes("opposition") ? [0.03, 0.98] : [0.93, 0.02]
  });
  const classifier: Classifier = Object.assign(
    async (premise: string, labels: string[]) => evaluate(premise, labels),
    {
      tokenizer: {
        encode: (text: string) => tokens(text),
        decode: (values: number[]) => values.map(value => words.get(value) ?? "").join(" ")
      },
      classifyBatch: async (premises: string[], labels: string[]) => {
        calls.push(premises);
        return premises.map(premise => evaluate(premise, labels));
      }
    }
  );
  return { classifier, calls };
}

function question(id: string, opposite = false): SemanticQuestion {
  return {
    premise: Array.from(Array<number>(600).keys(), index =>
      id + " evidence" + index + (opposite && index === 599 ? " opposition" : "")
    ).join(" "),
    same: "these are equivalent interfaces",
    different: "these interfaces have different contracts"
  };
}

test("batcher interleaves independent questions in one model invocation", async () => {
  const { classifier, calls } = runtime();
  const scheduler = createQuestionBatcher(classifier, 4);
  const questions = [question("alpha"), question("bravo", true), question("charlie"), question("delta")];
  const baseline = await Promise.all(questions.map(item => assessWindows(item, classifier, 1)));
  const observed: SemanticTimingEvent[] = [];
  const restore = observeSemanticTimings(event => { observed.push(event); });
  let results: WindowVerdict[] = [];
  try {
    results = await Promise.all(questions.map(item => scheduler.score(item)));
  } finally {
    restore();
  }
  assert.deepEqual(results, baseline);
  assert.ok(calls.some(batch => batch.some(item => item.includes("alpha")) &&
    batch.some(item => item.includes("bravo"))));
  assert.equal(observed.filter(event => event.phase === "verdict").length, questions.length);
  const windows = observed.filter(event => event.phase === "inference")
    .reduce((total, event) => total + event.batchSize, 0);
  assert.equal(windows, baseline.reduce((total, verdict) => total + verdict.evidence.windows, 0));
  assert.equal(supportsReuse(results[1] ?? { sameConcept: 0, differentConcept: 0 }), false);
});

test("batcher never mixes differing hypothesis labels in one invocation", async () => {
  const { classifier, calls } = runtime();
  const scheduler = createQuestionBatcher(classifier, 4);
  const first = question("first");
  const second = { ...question("second"), same: "a distinct hypothesis" };
  await Promise.all([scheduler.score(first), scheduler.score(second)]);
  assert.ok(calls.every(batch => {
    const hasFirst = batch.some(premise => premise.includes("first"));
    const hasSecond = batch.some(premise => premise.includes("second"));
    return !(hasFirst && hasSecond);
  }));
});

test("batcher propagates inference failure without leaving work pending", async () => {
  const { classifier } = runtime();
  const broken: Classifier = Object.assign(async () => { throw new Error("model failed"); }, {
    tokenizer: classifier.tokenizer,
    classifyBatch: async () => { throw new Error("model failed"); }
  });
  const scheduler = createQuestionBatcher(broken, 4);
  await assert.rejects(scheduler.score(question("failed")), /model failed/);
  await assert.rejects(scheduler.score(question("another")), /model failed/);
});
