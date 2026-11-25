# Detector evaluation

Source: [src/evaluation.ts](../../src/evaluation.ts)

A `FindingAnchor` identifies a diagnostic code, primary file, line and column, and optional related location. A `FindingLabel` adds a human-reviewed boolean indicating whether a finding should exist at that anchor. Include reviewed negative examples and unflagged positive examples, not just reported findings.

`evaluateFindings` returns an `EvaluationResult` with overall and per-code `EvaluationMetrics`: true positives, false positives, true negatives, false negatives, precision, recall and F1. A `Ratio` records the proportion, denominator and Wilson 95% interval. Undefined ratios are null. Unreviewed findings are listed separately, so the report cannot treat them as false positives or imply exhaustive recall. Related locations distinguish pairwise findings.

The `EvaluationManifest` records the full source revision, revision family, baseline detector revision, candidate detector revision and labels. `readEvaluationManifest` validates those fields; `readFindingAnchors` accepts ordinary CLI JSON output. The evaluator does not check out source or verify that an external report originated from its declared revision. Preserve the exact source, detector commits, scan arguments, model settings and complete report separately.

Run both detectors against the same unchanged source with equivalent settings, without changing source or guard suppressions. Review a sample including unflagged locations and compare both outputs with the same labels.

```sh
bun scripts/evaluate-findings.ts manifest.json baseline.json candidate.json
```

Report the sample selection and uncertainty. The Wilson intervals assume independent observations; correlated revision families require additional analysis. This utility does not establish real-model performance by itself. Keep evaluation families separate from calibration training.
