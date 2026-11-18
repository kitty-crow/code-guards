# Deterministic type contracts

Source: [`src/guards/types.ts`](../../../src/guards/types.ts)

`deterministicTypes` accepts a TypeScript Project, a test-file inclusion flag
and an issue emitter. It reports CG305 for explicit or inferred `any`,
`unknown` and `undefined`, including union constituents, generic type
arguments, optional declarations, optional chains and assignment assertions.
A direct nullish fallback must eliminate the unresolved type before the
value is stored or returned. Explicit undefined values, loose type arguments
and optional declarations remain findings. Assignment targets and discarded
void-compatible results do not constitute reads of unresolved values.

The analysis enables strict null checks, unchecked-index reporting,
implicit-any detection and unknown catch-variable semantics in a separate
TypeScript programme. It does not alter the target's configuration.
Concrete types, explicit `null` alternatives, discriminated unions and
`void` return signatures are supported. 
