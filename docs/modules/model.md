# Shared diagnostics contract

Source: [`src/model.ts`](../../src/model.ts)

`guards` is the ordered list of default-enabled rule modules. `GuardName`, `Severity`, `Location` and `Finding` describe the common warning schema. `location` converts a TypeScript AST position to a project-relative file, line and column.

## Behaviour and boundaries

A finding can include an offending `subject`, highlighted `span`, `reason`, `suggestion` and a related source location. All warning paths should use this contract.
