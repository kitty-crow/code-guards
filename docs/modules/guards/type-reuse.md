# Cross-module type reuse

Source: [`src/guards/type-reuse.ts`](../../../src/guards/type-reuse.ts)

`typeReuse` uses TypeScript’s type checker to fingerprint shapes of types, interfaces and classes. CG101 identifies structurally identical declarations, while CG102 and CG103 compare shortlisted overlapping definitions using local zero-shot inference. `SemanticScorer` can be injected for deterministic tests.

## Behaviour and boundaries

Classes with different runtime behaviour are never declared exact duplicates solely from matching properties. Scalar and array aliases are not equivalent. The tool makes suggestions and does not automatically merge types.

`CG103` requires compatible resolved field types and at least 65% semantic field-name overlap before the local model is consulted. Matching declaration names alone, or sharing only a small subset of configuration fields, is not sufficient evidence of reuse. `CG102` requires at least 70% exact field overlap plus model agreement.
