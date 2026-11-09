# Shared guard emitter

Source: [`src/guards/issue.ts`](../../../src/guards/issue.ts)

`Issue` is the internal source-level diagnostic description shared by `codeHealth` and `crossModule`. Its fields identify the issuing `guard`, diagnostic `code`, AST `node`, `message`, `reason`, `suggestion` and optional `related` node. `EmitIssue` is the callback contract for emitting one issue.

## Behaviour and boundaries

Rule implementations create an Issue before a project-relative location is known. The caller converts the AST node with `location` and attaches the source location to a public `Finding`. This keeps the rule emitters consistent and avoids repeating structurally identical type declarations across guard modules.
