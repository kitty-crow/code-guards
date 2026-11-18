# Deterministic type contracts

Source: [`src/guards/types.ts`](../../../src/guards/types.ts)

`deterministicTypes` accepts a TypeScript Project, a test-file inclusion flag
and an issue emitter. It reports CG305 for explicit or inferred `any`,
`unknown` and `undefined`, including union constituents, generic type
arguments, optional declarations, optional chains and assignment assertions.
It checks declaration and expression types and function return signatures.

The analysis enables strict null checks, unchecked-index reporting,
implicit-any detection and unknown catch-variable semantics in a separate
TypeScript programme. It does not alter the target's configuration.
Concrete types, explicit `null` alternatives, discriminated unions and
`void` return signatures are supported. The check uses the TypeScript
type checker rather than attempting to prove all runtime behaviour.
