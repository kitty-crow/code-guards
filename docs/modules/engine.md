# Guard orchestration

Source: [`src/engine.ts`](../../src/engine.ts)

`analyse` accepts `AnalysisOptions` with an enabled guard-name set, a tsconfig path and a test-file inclusion flag. It returns an `Analysis` containing findings and the resolved project root.

## Behaviour and boundaries

Individual guards remain independent. Semantic checks only load the model when a shortlisted comparison requires it.

The engine resolves line expectations against the complete selected guard output, including files with no findings.

## Progress granularity

The optional `analyse(config, onProgress)` callback receives status messages during project loading and each scan stage. The engine reports the number of analysed files, enabled rules, stage names, per-stage finding counts, inference-window totals and elapsed time. All 23 rules remain enabled by default; the deterministic code-health and cross-module rules share their existing traversals. When progress reporting is not requested, findings retain the same structure and strict-mode behaviour. `analyse` restores its semantic-progress observer on completion or failure.

Accelerated inference changes only the semantic model execution path.
It does not change the deterministic TypeScript rules. Stage progress
counts completed windows, including multiple windows in a single batch.
