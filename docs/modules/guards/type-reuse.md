# Cross-module type reuse

Source: [`src/guards/type-reuse.ts`](../../../src/guards/type-reuse.ts)

`typeReuse` uses TypeScript’s type checker to fingerprint shapes of types, interfaces and classes. CG101 identifies structurally identical declarations, while CG102 and CG103 compare shortlisted overlapping definitions using local zero-shot inference. `SemanticScorer` can be injected for deterministic tests.

## Behaviour and boundaries

Merged declarations are collected once by their TypeScript symbol, with the original declaration preferred over module augmentations. Named aliases (including generic specialisations) already reuse a definition and are not independent duplicates. Structural fingerprints retain generic arguments and literal discriminants; CG101 additionally requires mutual TypeScript assignability for concrete types. Independent generic declarations use position-normalised formal parameters, constraints and defaults, and cannot be exact matches on a truncated fingerprint alone.

Classes with different runtime behaviour are never declared exact duplicates solely from matching properties. Scalar and array aliases are not equivalent. The tool makes suggestions and does not automatically merge types.

`CG103` requires compatible resolved field types and at least 65% semantic field-name overlap before the local model is consulted. Matching declaration names alone, or sharing only a small subset of configuration fields, is not sufficient evidence of reuse. `CG102` requires at least 70% exact field overlap plus model agreement.

Compiler-generated qualified names for modules inside the scanned project use project-relative identities, preserving their directory structure. Semantic questions no longer depend on an absolute checkout location for these names. Existing cache entries with absolute paths remain intact but cannot be reused for questions whose text changed; the portable questions are cached normally thereafter. External module identities and literal values are not deliberately rewritten.

### Inherited declarations

An inherited member with the same compiler declaration identity in two types is already reused. CG101/CG102/CG103 compare independently declared members rather than treating shared base members as duplicate implementations. Independently declared overrides and separate structural contracts remain eligible for review. Exact duplicate extensions with independently repeated members remain reportable.

### Implemented contracts

For an explicit class implements clause, matching member names and resolved type fingerprints are associated with the original contract declaration. Members represented by the same contract are excluded from overlap comparisons, including comparisons against the contract itself. Independently declared fields and explicit overrides remain eligible; unrelated interfaces with similar shapes do not acquire a shared identity. This comparison covers direct implements clauses, not every possible transitive or implicit implementation.
