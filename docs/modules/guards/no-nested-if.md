# Nested conditional detection

Source: [`src/guards/no-nested-if.ts`](../../../src/guards/no-nested-if.ts)

`noNestedIf` traverses TypeScript AST and emits CG001 for nested if statements and else-if chains. Each function-like boundary resets the nesting level. The finding identifies inner and outer conditions with a suggestion tailored to the surrounding return or else behaviour.

## Behaviour and boundaries

An early-return rewrite is only safe when it preserves function exit and fallback semantics. `else if` branches must not be split into independent ifs without checking branch exclusivity.
