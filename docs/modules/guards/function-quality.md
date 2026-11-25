# Function and method quality checks

Source: [`src/guards/function-quality.ts`](../../../src/guards/function-quality.ts)

`functionQuality` reports `CG201` to `CG205`:

- Large or branch-heavy functions
- Missing explanations of non-obvious decisions
- Heavy coupling to other source modules
- Small stateless methods
- Duplicate implementations

| Finding | Evidence |
| --- | --- |
| Exact duplicates | Structural body comparison |
| Ambiguous candidates | `SemanticScorer` |

## Behaviour and boundaries

Structural comparison removes comments and formatting without discarding call names or string contents. Resolved call declarations distinguish same-named operations from different modules. CG204 excludes methods required by explicit base or interface contracts. Other public API obligations require review.

`CG202` reviews branch-heavy functions even when comments exist. It uses source-located comment trivia, not slash markers inside string literals. A comment is useful when it explains a non-obvious invariant or safety condition; narrated comments are not an acceptable way to satisfy it, and are checked separately by `CG319`.

Set `CODE_GUARDS_EXPERIMENTAL_CODE=1` to add code-embedding retrieval for CG205. Candidates are grouped by parameter count and compared in cohorts of up to 256 implementations; only cross-file pairs not already covered by baseline comparison enter this additional shortlist. The specialist does not decide whether behaviour is equivalent. MobileBERT receives the selected source implementations and resolved call targets. Overlength evidence and partitioned cohorts are reported. Real-model performance and accuracy require separate evaluation.

CG205's exact fingerprint includes the compiler signature and external declaration identities in addition to the normalised body and resolved call targets. Identical text using different captured state is not exact duplication. Semantic comparisons receive both typed contracts, resolved external references, explicit write/throw/await/return counts and complete implementation bodies. Syntax counts are observations, not proof that an operation is pure or has no transitive effects.

Disjoint primitive return domains refute whole-function equivalence before neural comparison. For example, a numeric measurement and a boolean predicate have different contracts even when both perform a similar computation. This does not establish that their internal subexpressions cannot be shared.

CG201 and CG203 use typed behavioural facts and full implementation evidence to examine separable invariants and actual dependency ownership rather than relying on size or dependency counts alone. Counts remain candidate triggers.
