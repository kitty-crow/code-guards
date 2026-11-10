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

The model receives AST-derived metrics, not a proof of design intent. Review false positives, especially when a public API intentionally wraps a helper.

`CG202` only considers branch-heavy functions without detected comments. A comment is useful when it explains a non-obvious invariant or safety condition; narrated comments are not an acceptable way to satisfy it, and are checked separately by `CG319`.
