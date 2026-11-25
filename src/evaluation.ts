import type { Location } from "./model.ts";
import { JsonRecord, parseRecord } from "./json.ts";

export type FindingAnchor = {code: string; location: Location; related: Location | null};
export type FindingLabel = FindingAnchor & {present: boolean};
export type Ratio = {value: number; lower95: number; upper95: number; count: number} | null;
export type EvaluationMetrics = {
  truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number;
  precision: Ratio; recall: Ratio; f1: number | null;
};
export type EvaluationResult = {
  overall: EvaluationMetrics;
  byCode: Record<string, EvaluationMetrics>;
  unlabelled: FindingAnchor[];
};
type Counts = Pick<EvaluationMetrics, "truePositive" | "falsePositive" | "trueNegative" | "falseNegative">;

function anchorKey(anchor: FindingAnchor): string {
  const place = (location: Location): (string | number)[] => [location.file, location.line, location.column];
  return JSON.stringify([anchor.code, place(anchor.location), anchor.related ? place(anchor.related) : null]);
}

function emptyCounts(): Counts {
  return {truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0};
}

function ratio(successes: number, count: number): Ratio {
  if (!count) return null;
  const value = successes / count;
  const z = 1.959963984540054;
  const denominator = 1 + z * z / count;
  const centre = (value + z * z / (2 * count)) / denominator;
  const margin = z * Math.sqrt(value * (1 - value) / count + z * z / (4 * count * count)) / denominator;
  return {value, lower95: Math.max(0, centre - margin), upper95: Math.min(1, centre + margin), count};
}

function metrics(counts: Counts): EvaluationMetrics {
  const {truePositive: tp, falsePositive: fp, falseNegative: fn} = counts;
  const denominator = 2 * tp + fp + fn;
  return {...counts, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    f1: denominator ? 2 * tp / denominator : null};
}

function record(counts: Counts, present: boolean, detected: boolean): void {
  if (present && detected) counts.truePositive += 1;
  if (!present && detected) counts.falsePositive += 1;
  if (!present && !detected) counts.trueNegative += 1;
  if (present && !detected) counts.falseNegative += 1;
}

/** Evaluate only reviewed anchors. Unreviewed findings are not assumed false. */
export function evaluateFindings(labels: readonly FindingLabel[], findings: readonly FindingAnchor[]): EvaluationResult {
  if (!labels.length) throw new Error("Evaluation requires independently reviewed positive and negative anchors.");
  const detected = new Map(findings.map(finding => [anchorKey(finding), finding]));
  const reviewed = new Set<string>();
  const overall = emptyCounts();
  const counts = new Map<string, Counts>();
  for (const label of labels) {
    const key = anchorKey(label);
    if (reviewed.has(key)) throw new Error("Duplicate evaluation anchor: " + key);
    reviewed.add(key);
    const group = counts.get(label.code) ?? emptyCounts();
    record(group, label.present, detected.has(key));
    record(overall, label.present, detected.has(key));
    counts.set(label.code, group);
  }
  return {
    overall: metrics(overall),
    byCode: Object.fromEntries([...counts.entries()].map(([code, group]) => [code, metrics(group)])),
    unlabelled: [...detected.entries()].filter(([key]) => !reviewed.has(key)).map(([, finding]) => finding)
  };
}

function place(record: JsonRecord): Location {
  const file = record.text("file");
  const line = record.number("line");
  const column = record.number("column");
  if (!file || !Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) throw new Error("Invalid evaluation location.");
  return {file, line, column};
}

function anchor(record: JsonRecord): FindingAnchor {
  const code = record.text("code");
  if (!/^CG\d{3}$/.test(code)) throw new Error("Invalid evaluation diagnostic code.");
  const related = record.get("related");
  if (related !== null && !(related instanceof JsonRecord)) throw new Error("Invalid related evaluation location.");
  return {code, location: place(record.record("location")), related: related ? place(related) : null};
}

function label(record: JsonRecord): FindingLabel {
  const present = record.get("present");
  if (typeof present !== "boolean") throw new Error("Evaluation label must be boolean.");
  return {...anchor(record), present};
}

function records(record: JsonRecord, field: string): JsonRecord[] {
  const value = record.get(field);
  if (!Array.isArray(value)) throw new Error("Expected evaluation array: " + field);
  return value.map(item => {
    if (!(item instanceof JsonRecord)) throw new Error("Expected evaluation record.");
    return item;
  });
}

export type EvaluationManifest = {
  sourceRevision: string; revisionFamily: string;
  baselineDetector: string; candidateDetector: string;
  labels: FindingLabel[];
};

/** Decode an explicit revision-labelled review manifest without deriving truth from the detector. */
export function readEvaluationManifest(input: string): EvaluationManifest {
  const data = parseRecord(input);
  const sourceRevision = data.text("sourceRevision");
  const baselineDetector = data.text("baselineDetector");
  const candidateDetector = data.text("candidateDetector");
  const revisionFamily = data.text("revisionFamily");
  if (![sourceRevision, baselineDetector, candidateDetector].every(value => /^[a-f0-9]{40}$/.test(value)) ||
      !revisionFamily.trim() || baselineDetector === candidateDetector) throw new Error("Evaluation requires exact source and distinct detector revisions.");
  return {sourceRevision, revisionFamily, baselineDetector, candidateDetector, labels: records(data, "labels").map(label)};
}

/** Read ordinary CLI JSON output; the caller must verify its revision provenance. */
export function readFindingAnchors(input: string): FindingAnchor[] {
  return records(parseRecord('{"findings":' + input + '}'), "findings").map(anchor);
}
