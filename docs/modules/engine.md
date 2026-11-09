# Guard orchestration

Source: [`src/engine.ts`](../../src/engine.ts)

`analyse` accepts `AnalysisOptions` with an enabled guard-name set, a tsconfig path and a test-file inclusion flag. It returns an `Analysis` containing findings and the resolved project root.

## Behaviour and boundaries

Individual guards remain independent. Semantic checks only load the model when a shortlisted comparison requires it.
