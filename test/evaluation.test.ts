import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evaluateFindings, readEvaluationManifest, readFindingAnchors, type FindingAnchor } from "../src/evaluation.ts";

function at(line: number, code = "CG205"): FindingAnchor {
  return {code, location: {file: "src/example.ts", line, column: 1}, related: null};
}

test("evaluation counts missed positives and reviewed negatives without assuming unreviewed findings are false", () => {
  const labels = [
    {...at(1), present: true}, {...at(2), present: true},
    {...at(3), present: false}, {...at(4, "CG411"), present: false}
  ];
  const result = evaluateFindings(labels, [at(1), at(3), at(5)]);
  assert.equal(result.overall.truePositive, 1);
  assert.equal(result.overall.falsePositive, 1);
  assert.equal(result.overall.falseNegative, 1);
  assert.equal(result.overall.trueNegative, 1);
  assert.equal(result.overall.f1, 0.5);
  const precision = result.overall.precision;
  assert.ok(precision);
  assert.equal(precision.value, 0.5);
  assert.ok(precision.lower95 < 0.5 && precision.upper95 > 0.5);
  assert.deepEqual(result.unlabelled, [at(5)]);
  assert.equal(result.byCode["CG411"]?.recall ?? null, null);
  assert.throws(() => evaluateFindings([...labels, {...at(1), present: false}], []), /Duplicate/);
});

test("evaluation preserves related locations and validates explicit provenance", () => {
  const first = {...at(1), related: at(2).location};
  const other = {...at(1), related: at(3).location};
  const labels = [{...first, present: true}, {...other, present: false}];
  const manifest = {sourceRevision: "a".repeat(40), revisionFamily: "sample-family",
    baselineDetector: "b".repeat(40), candidateDetector: "c".repeat(40), labels};
  assert.deepEqual(readEvaluationManifest(JSON.stringify(manifest)), manifest);
  const result = evaluateFindings(labels, readFindingAnchors(JSON.stringify([other])));
  assert.equal(result.overall.falseNegative, 1);
  assert.equal(result.overall.falsePositive, 1);
  assert.throws(() => readEvaluationManifest(JSON.stringify({...manifest, sourceRevision: "main"})), /exact source/);
  assert.throws(() => readEvaluationManifest(JSON.stringify({...manifest, labels: [{...first, present: "yes"}]})), /boolean/);
});
