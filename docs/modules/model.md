# Shared diagnostics contract

Source: [`src/model.ts`](../../src/model.ts)

`guards` is the ordered list of default-enabled rule modules. `GuardName`, `Severity`, `Location` and `Finding` describe the common warning schema. `location` converts a TypeScript AST position to a project-relative file, line and column.

## Behaviour and boundaries

A finding includes a `subject`, `reason` and `suggestion`. The guard can attach an excerpt span, a related location or a similarity score. Use a property-presence check before reading these fields.
