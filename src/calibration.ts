/** Task-specific calibration of binary finding correctness, independent of inference. */
export type CalibrationSample = {
  task: string;
  revisionFamily: string;
  score: number;
  correct: boolean;
  windows: number;
};
export type CalibrationFit = {
  task: string;
  temperature: number;
  trainingFamilies: string[];
  trainingCount: number;
  version: "binary-temperature-v1";
};
export type ReliabilityBin = {
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number;
  observedAccuracy: number;
};
export type CalibrationMetrics = {
  count: number;
  brier: number;
  expectedCalibrationError: number;
  bins: ReliabilityBin[];
};
export type WindowCalibration = { range: string; raw: CalibrationMetrics; calibrated: CalibrationMetrics };

function validateSample(sample: CalibrationSample, task: string): void {
  if (sample.task !== task || !sample.revisionFamily.trim() ||
      !Number.isFinite(sample.score) || sample.score < 0 || sample.score > 1 ||
      !Number.isSafeInteger(sample.windows) || sample.windows < 1) {
    throw new Error("Invalid calibration sample or mismatched task.");
  }
}

function logOdds(score: number): number {
  const bounded = Math.max(1e-7, Math.min(1 - 1e-7, score));
  return Math.log(bounded / (1 - bounded));
}

function scaled(score: number, temperature: number): number {
  return 1 / (1 + Math.exp(-logOdds(score) / temperature));
}

function loss(samples: readonly CalibrationSample[], temperature: number): number {
  return samples.reduce((sum, sample) => {
    const confidence = scaled(sample.score, temperature);
    const assigned = sample.correct ? confidence : 1 - confidence;
    return sum - Math.log(Math.max(assigned, 1e-15));
  }, 0) / samples.length;
}

/** Fit on independently labelled examples; never infer labels from model scores. */
export function fitCalibration(task: string, samples: readonly CalibrationSample[]): CalibrationFit {
  if (!task.trim() || samples.length < 2) throw new Error("Calibration requires a task and labelled samples.");
  for (const sample of samples) validateSample(sample, task);
  const families = [...new Set(samples.map(sample => sample.revisionFamily))].sort();
  if (families.length < 2 || !samples.some(sample => sample.correct) || !samples.some(sample => !sample.correct)) {
    throw new Error("Calibration requires multiple revision families and both correctness labels.");
  }
  let temperature = 1;
  let best = loss(samples, temperature);
  // Search a bounded log-temperature grid deterministically. Include the
  // uncalibrated baseline, so fitting cannot worsen training log loss.
  for (let index = -60; index <= 60; index += 1) {
    const candidate = Math.exp(index / 20);
    const candidateLoss = loss(samples, candidate);
    if (candidateLoss >= best) continue;
    best = candidateLoss;
    temperature = candidate;
  }
  return {task, temperature, trainingFamilies: families, trainingCount: samples.length, version: "binary-temperature-v1"};
}

export function applyCalibration(fit: CalibrationFit, task: string, score: number): number {
  if (fit.task !== task || fit.version !== "binary-temperature-v1" ||
      !Number.isFinite(fit.temperature) || fit.temperature <= 0 ||
      !Number.isFinite(score) || score < 0 || score > 1) throw new Error("Incompatible calibration input.");
  return scaled(score, fit.temperature);
}

function metrics(samples: readonly CalibrationSample[], confidence: (sample: CalibrationSample) => number): CalibrationMetrics {
  const buckets = new Map<number, {count: number; total: number; correct: number}>();
  let squared = 0;
  for (const sample of samples) {
    const predicted = confidence(sample);
    const label = sample.correct ? 1 : 0;
    squared += (predicted - label) ** 2;
    const index = Math.min(9, Math.floor(predicted * 10));
    const bin = buckets.get(index) ?? {count: 0, total: 0, correct: 0};
    bin.count += 1;
    bin.total += predicted;
    bin.correct += label;
    buckets.set(index, bin);
  }
  const bins = [...buckets.entries()].sort(([a], [b]) => a - b).map(([index, bin]) => ({
    lower: index / 10, upper: (index + 1) / 10, count: bin.count,
    meanConfidence: bin.total / bin.count, observedAccuracy: bin.correct / bin.count
  }));
  const count = samples.length;
  const expectedCalibrationError = bins.reduce((sum, bin) =>
    sum + bin.count * Math.abs(bin.meanConfidence - bin.observedAccuracy), 0) / count;
  return {count, brier: squared / count, expectedCalibrationError, bins};
}

/** Keep evaluation revision families disjoint from the calibration set. */
export function evaluateCalibration(fit: CalibrationFit, samples: readonly CalibrationSample[]): {
  raw: CalibrationMetrics; calibrated: CalibrationMetrics; byWindowCount: WindowCalibration[]
} {
  if (!samples.length) throw new Error("Evaluation requires held-out labelled samples.");
  for (const sample of samples) {
    validateSample(sample, fit.task);
    if (fit.trainingFamilies.includes(sample.revisionFamily)) throw new Error("Calibration and evaluation revision families overlap.");
  }
  const calibrated = (sample: CalibrationSample): number => applyCalibration(fit, sample.task, sample.score);
  const groups = [
    {range: "1", items: samples.filter(sample => sample.windows === 1)},
    {range: "2-4", items: samples.filter(sample => sample.windows >= 2 && sample.windows <= 4)},
    {range: "5+", items: samples.filter(sample => sample.windows >= 5)}
  ];
  return {
    raw: metrics(samples, sample => sample.score),
    calibrated: metrics(samples, calibrated),
    byWindowCount: groups.filter(group => group.items.length > 0).map(group => ({
      range: group.range, raw: metrics(group.items, sample => sample.score),
      calibrated: metrics(group.items, calibrated)
    }))
  };
}
