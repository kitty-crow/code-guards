import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyCalibration, evaluateCalibration, fitCalibration, readCalibrationDataset, calibrateDataset, type CalibrationSample } from "../src/calibration.ts";

function sample(revisionFamily: string, score: number, correct: boolean, windows = 1): CalibrationSample {
  return {task: "CG205", revisionFamily, score, correct, windows};
}

test("calibration keeps revision families separate and measures held-out reliability by window count", () => {
  const fit = fitCalibration("CG205", [
    sample("train-a", 0.95, true), sample("train-a", 0.95, false),
    sample("train-b", 0.05, true), sample("train-b", 0.05, false)
  ]);
  const result = evaluateCalibration(fit, [
    sample("eval-a", 0.95, true), sample("eval-a", 0.95, false, 3),
    sample("eval-b", 0.05, true, 7), sample("eval-b", 0.05, false, 7)
  ]);
  assert.ok(fit.temperature > 1);
  assert.ok(result.calibrated.brier < result.raw.brier);
  assert.ok(result.calibrated.expectedCalibrationError < result.raw.expectedCalibrationError);
  assert.equal(result.calibrated.count, 4);
  assert.deepEqual(result.byWindowCount.map(item => item.range), ["1", "2-4", "5+"]);
  assert.equal(result.calibrated.bins.reduce((sum, bin) => sum + bin.count, 0), 4);
  assert.throws(() => evaluateCalibration(fit, [sample("train-a", 0.9, true)]), /overlap/);
  assert.throws(() => applyCalibration(fit, "CG101", 0.9), /Incompatible/);
});

test("calibration rejects unsupported samples and one-label training data", () => {
  assert.throws(() => fitCalibration("CG205", [sample("a", 1, true), sample("b", 0.9, true)]), /both correctness labels/);
  assert.throws(() => fitCalibration("CG205", [sample("a", 2, false), sample("b", 0.9, true)]), /Invalid/);
});

test("calibration datasets retain exact review provenance and prevent revision leakage", () => {
  const row = (revision: string, family: string, correct: boolean, anchor: string) =>
    ({sourceRevision: revision.repeat(40), revisionFamily: family, anchor, correct, score: 0.9, windows: 1});
  const data = {task: "CG205", detectorRevision: "a".repeat(40), modelIdentity: "checkpoint/provider/scoring-abi",
    training: [row("b", "train1", true, "a"), row("c", "train2", false, "b")],
    evaluation: [row("d", "eval1", true, "c"), row("e", "eval2", false, "d")]};
  const dataset = readCalibrationDataset(JSON.stringify(data));
  const result = calibrateDataset(dataset);
  assert.equal(result.detectorRevision, data.detectorRevision);
  assert.equal(result.metrics.raw.count, 2);
  assert.throws(() => readCalibrationDataset(JSON.stringify({...data, evaluation: [row("b", "eval2", true, "different-anchor")]})), /revisions overlap/);
});
