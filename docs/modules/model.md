# Shared diagnostics contract

Source: [`src/model.ts`](../../src/model.ts)

`guards` is the ordered list of default-enabled rule modules. `GuardName`, `Severity`, `Location` and `Finding` describe the common warning schema. `location` converts a TypeScript AST position to a project-relative file, line and column.

## Behaviour and boundaries

A finding includes a `subject`, `reason` and `suggestion`. The guard can attach an excerpt span, a related location or a similarity score. Use a property-presence check before reading these fields.

`withoutIgnored(root, findings)` filters primary locations by the exact next-line `//@cg-ignore` directive. Each guard applies this filter before returning results. The helper reads each affected file once per invocation, handles LF and CRLF, and retains findings when the reported file cannot be read. Related locations and compiler diagnostics are unchanged.

`resolveExpectations(root, files, findings)` consumes warnings and errors on lines marked by an expectation. It emits CG327 for unused expectations: error for `//@cg-expect-error`, warning for `//@cg-expect-warning`. Call once after combining selected guard results. `failed(findings, strict)` evaluates the exit status without altering severities.
