# Deterministic type contracts

Source: [`src/guards/types.ts`](../../../src/guards/types.ts)

`deterministicTypes(project, includeTests, report)` emits CG305 through
`report` for loose types and unchecked values in the project.

- Checks explicit and inferred `any`, `unknown` and `undefined`, including union members and generic arguments.
- Reports optional declarations, optional chains and definite-assignment assertions.
- Checks catch variables at the point of use. Narrow the exception with a runtime type check.
- Accepts a direct fallback that resolves a possibly missing API result, for example `items[0] ?? null`.
- Accepts calls with a typed result that may be missing when the result is discarded.
- Accepts concrete types, explicit `null` alternatives, discriminated unions and `void` signatures.

The guard creates a TypeScript program with strict null checks, unchecked-index
checks and implicit-any detection. Set `includeTests` to scan test files.

CG305 reports a propagated inferred type at its originating expression when the receiving declaration repeats the same diagnostic. Explicit contracts and separate unchecked indices retain their findings. Bounded reads from dense array literals and canonical typed-array loops use the proof in [index bounds](index-bounds.md).
