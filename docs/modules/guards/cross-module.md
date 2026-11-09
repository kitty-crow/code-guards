# Cross-module conventions and configuration

Source: [`src/guards/cross-module.ts`](../../../src/guards/cross-module.ts)

`crossModule` examines literal configuration constants and known HTTP client patterns across source modules. CG304 reports similarly named constants repeating long string values. CG309 reports direct fetch calls outside a module that defines an API client.

## Behaviour and boundaries

A repeated literal or direct HTTP call is not automatically wrong. Check shared semantics before following a suggestion; the tool never changes source code.
