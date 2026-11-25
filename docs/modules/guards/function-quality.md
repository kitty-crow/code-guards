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

`CG202` only considers branch-heavy functions without detected comments. A comment is useful when it explains a non-obvious invariant or safety condition; narrated comments are not an acceptable way to satisfy it, and are checked separately by `CG319`.
