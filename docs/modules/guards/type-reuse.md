# Cross-module type reuse

Source: [`src/guards/type-reuse.ts`](../../../src/guards/type-reuse.ts)

`typeReuse` uses TypeScript’s type checker to fingerprint shapes of types, interfaces and classes. CG101 identifies structurally identical declarations, while CG102 and CG103 compare shortlisted overlapping definitions using local zero-shot inference. `SemanticScorer` can be injected for deterministic tests.

## Behaviour and boundaries

Merged declarations are collected once by their TypeScript symbol, with the original declaration preferred over module augmentations. Named aliases (including generic specialisations) already reuse a definition and are not independent duplicates. Structural fingerprints retain generic arguments and literal discriminants; CG101 additionally requires mutual TypeScript assignability for concrete types. Independent generic declarations use position-normalised formal parameters, constraints and defaults, and cannot be exact matches on a truncated fingerprint alone.

Classes with different runtime behaviour are never declared exact duplicates solely from matching properties. Scalar and array aliases are not equivalent. The tool makes suggestions and does not automatically merge types.

`CG103` requires compatible resolved field types and at least 65% semantic field-name overlap before the local model is consulted. Matching declaration names alone, or sharing only a small subset of configuration fields, is not sufficient evidence of reuse. `CG102` requires at least 70% exact field overlap plus model agreement.
