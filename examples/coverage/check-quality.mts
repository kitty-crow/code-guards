/** Small labelled internal experiment. The fixture labels predate inference. */
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFixture } from "../../test/fixture.ts";
import { loadProject } from "../../src/project.ts";
import { functionQuality } from "../../src/guards/function-quality.ts";
import { createCodeExpert } from "../../src/experts.ts";
import { zeroShot, disposeLocalSemanticModel, MODEL, type WindowVerdict } from "../../src/semantic.ts";
import { evaluateFindings, type FindingAnchor, type FindingLabel } from "../../src/evaluation.ts";
import { fitCalibration, evaluateCalibration, type CalibrationSample } from "../../src/calibration.ts";
import type { Finding } from "../../src/model.ts";

type Example = {id: string; parameter: string; left: string; right: string; present: boolean; split: "train" | "evaluation"; rationale: string};
const examples: Example[] = [
  {id: "trim-empty", parameter: "text: string", left: "const clean = text.trim(); const empty = clean.length === 0; return empty;",
    right: "const clean = text.trim(); const size = clean.length; return size < 1;", present: true, split: "train", rationale: "String length is a nonnegative integer; both test an empty trimmed string."},
  {id: "case-conversion", parameter: "text: string", left: "const clean = text.trim(); const result = clean.toUpperCase(); return result;",
    right: "const clean = text.trim(); const result = clean.toLowerCase(); return result;", present: false, split: "train", rationale: "Input 'a' gives distinct output strings."},
  {id: "first-field", parameter: "text: string", left: "const parts = text.split(','); const first = parts[0] ?? ''; return first;",
    right: "const comma = text.indexOf(','); const end = comma < 0 ? text.length : comma; return text.slice(0, end);", present: true, split: "train", rationale: "Both return the substring preceding the first comma, or the entire string."},
  {id: "edge-field", parameter: "text: string", left: "const clean = text.trim(); const result = clean.slice(0, 2); return result;",
    right: "const clean = text.trim(); const result = clean.slice(-2); return result;", present: false, split: "train", rationale: "Input 'abcd' gives 'ab' versus 'cd'."},
  {id: "bool-inversion", parameter: "flag: boolean", left: "const inverted = !flag; const result = !inverted; return result;",
    right: "const value = flag; const result = value === true; return result;", present: true, split: "evaluation", rationale: "The declared boolean domain has two values; both functions return the input."},
  {id: "bool-polarity", parameter: "flag: boolean", left: "const value = !flag; const result = value; return result;",
    right: "const value = flag; const result = value; return result;", present: false, split: "evaluation", rationale: "Both boolean inputs produce distinct results."},
  {id: "prefix", parameter: "text: string", left: "const clean = text.trim(); const first = clean.slice(0, 3); return first;",
    right: "const value = text.trim(); const end = 3; return value.substring(0, end);", present: true, split: "evaluation", rationale: "Both select at most the first three UTF-16 code units after trimming."},
  {id: "delimiter", parameter: "text: string", left: "const parts = text.split(','); const result = parts[0] ?? ''; return result;",
    right: "const parts = text.split(','); const result = parts.at(-1) ?? ''; return result;", present: false, split: "evaluation", rationale: "Input 'a,b' yields distinct first and last fields."}
];

function place(id: string, file: string) {
  return {file: id + "/" + file, line: 1, column: 17};
}

function anchors(id: string, findings: Finding[]): FindingAnchor[] {
  return findings.filter(item => item.code === "CG205").map(item => ({
    code: item.code, location: {...item.location, file: id + "/" + item.location.file},
    related: "related" in item ? {...item.related, file: id + "/" + item.related.file} : null
  }));
}

// Each case is isolated, so an unrelated third implementation cannot alter
// its candidate ranking. Capture scores before evaluating the fixed labels.
async function review(example: Example, cache: string, roots: string[]) {
  const root = writeFixture({
    "tsconfig.json": JSON.stringify({compilerOptions: {strict: true, noEmit: true, target: "ES2022"}, include: ["src/*.ts"]}),
    "src/a.ts": `export function first(${example.parameter}) { ${example.left} }\n`,
    "src/b.ts": `export function second(${example.parameter}) { ${example.right} }\n`
  }, roots, "cg-quality-");
  const project = loadProject(root);
  const before = performance.now();
  const baseline = await functionQuality(project, false, zeroShot);
  const baselineMs = performance.now() - before;
  const expert = createCodeExpert(cache);
  const scores: WindowVerdict[] = [];
  const started = performance.now();
  const candidate = await functionQuality(project, false, async question => {
    const result = await zeroShot(question);
    if ("comparison" in question) scores.push(result);
    return result;
  }, expert).finally(() => expert.close());
  const label: FindingLabel = {code: "CG205", location: place(example.id, "src/b.ts"), related: place(example.id, "src/a.ts"), present: example.present};
  const only = scores.length === 1 ? scores[0] ?? null : null;
  const sample: CalibrationSample | null = only ? {task: "CG205", revisionFamily: example.id,
    score: only.sameConcept, correct: example.present, windows: only.evidence.windows} : null;
  return {id: example.id, split: example.split, label, rationale: example.rationale, baseline: anchors(example.id, baseline),
    candidate: anchors(example.id, candidate), baselineMs, candidateMs: performance.now() - started, expert: expert.metrics, sample, scores};
}

const roots: string[] = [];
const cache = mkdtempSync(path.join(tmpdir(), "cg-quality-cache-"));
try {
  const results: Awaited<ReturnType<typeof review>>[] = [];
  for (const example of examples) results.push(await review(example, cache, roots));
  const labels = results.map(result => result.label);
  const baseline = evaluateFindings(labels, results.flatMap(result => result.baseline));
  const candidate = evaluateFindings(labels, results.flatMap(result => result.candidate));
  const training = results.filter(result => result.split === "train").flatMap(result => result.sample ? [result.sample] : []);
  const evaluation = results.filter(result => result.split === "evaluation").flatMap(result => result.sample ? [result.sample] : []);
  const sufficient = training.length >= 2 && training.some(sample => sample.correct) && training.some(sample => !sample.correct) && evaluation.length > 0;
  const fit = sufficient ? fitCalibration("CG205", training) : null;
  const calibration = fit ? {fit, metrics: evaluateCalibration(fit, evaluation)} : null;
  console.log(JSON.stringify({fixtureDigest: createHash("sha256").update(JSON.stringify(examples)).digest("hex"),
    detectorRevision: process.env.GITHUB_SHA ?? "local", model: MODEL, baseline: {variant: "compiler+judge", metrics: baseline},
    candidate: {variant: "compiler+code-retrieval+judge", metrics: candidate}, calibration, results}, null, 2));
} finally {
  await disposeLocalSemanticModel();
  for (const root of [...roots, cache]) rmSync(root, {recursive: true, force: true});
}
