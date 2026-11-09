# Function and method quality checks

Source: [`src/guards/function-quality.ts`](../../../src/guards/function-quality.ts)

`functionQuality` scans functions and methods for long or branch-heavy bodies, missing explanations for ambiguous logic, external-module coupling, stateless tiny methods and duplicate implementations. It emits CG201–CG205. Exact duplicate bodies are detected deterministically; ambiguous candidates use an injectable `SemanticScorer`.

## Behaviour and boundaries

The model receives AST-derived metrics, not a proof of design intent. Review false positives, especially when a public API intentionally wraps a helper.
