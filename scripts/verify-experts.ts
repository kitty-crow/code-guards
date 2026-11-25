#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodeExpert, createProseExpert, CODE_EXPERT, PROSE_EXPERT, type SourceEvidence, type EmbeddingExpert, type ExpertProfile } from "../src/experts.ts";

function passages(values: string[]): SourceEvidence[] {
  return values.map((text, index) => ({text, location: {file: "example", line: index + 1, column: 1}}));
}

// Separate cold and warm sessions. This checks a real runtime, not a mock,
// and does not infer population-wide accuracy from the small example set.
async function measure(profile: ExpertProfile, create: (directory: string) => EmbeddingExpert, inputs: SourceEvidence[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "code-guards-expert-check-"));
  try {
    const cold = create(directory);
    const start = performance.now();
    const first = await cold.rank(inputs).finally(() => cold.close());
    const coldMilliseconds = performance.now() - start;
    assert.equal(first.unresolved.length, 0);
    assert.equal(cold.metrics.loads, 1);
    assert.equal(cold.metrics.encodedInputs, inputs.length);
    assert.ok(first.matches.length > 0);
    const warm = create(directory);
    const warmStart = performance.now();
    const second = await warm.rank(inputs).finally(() => warm.close());
    const warmMilliseconds = performance.now() - warmStart;
    assert.deepEqual(second, first);
    assert.equal(warm.metrics.loads, 0);
    assert.equal(warm.metrics.persistentHits, inputs.length);
    assert.equal(warm.metrics.encodedInputs, 0);
    return {model: profile.model, revision: profile.revision, provider: profile.provider,
      coldMilliseconds, warmMilliseconds, cold: cold.metrics, warm: warm.metrics,
      matches: first.matches.map(match => ({earlier: match.earlier.location.line, later: match.later.location.line, relevance: match.relevance}))};
  } finally { rmSync(directory, {recursive: true, force: true}); }
}

const budget = Number(process.env.CODE_GUARDS_EXPERT_RAM_MIB ?? "2048") * 1048576;
const prose = await measure(PROSE_EXPERT, directory => createProseExpert(directory, budget), passages([
  "The service rejects writes while the connection is closed.",
  "A disconnected client cannot write records.",
  "The image renderer supports transparent PNG output."
]));
const code = await measure(CODE_EXPERT, directory => createCodeExpert(directory, budget), passages([
  "function first(value: number) { return Math.max(0, value); }",
  "function second(value: number) { return value < 0 ? 0 : value; }",
  "function third(text: string) { return text.split(','); }"
]));
console.log(JSON.stringify({prose, code}, null, 2));
