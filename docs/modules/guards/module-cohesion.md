# Module responsibility and cohesion

Source: [`src/guards/module-cohesion.ts`](../../../src/guards/module-cohesion.ts)

`moduleCohesion` finds modules that implement unrelated operational responsibilities. It inspects top-level functions, classes, executable declarations and script operations with the TypeScript AST. A local zero-shot model first assesses the module's overall cohesion and then compares concrete implementations. `CG206` requires both assessments to support separation with limited contradictory evidence.

## Responsibility breakout

Each warning identifies two independent operations and their source locations. The suggested breakout names the declarations and observed calls associated with each responsibility, recommends separate focused modules and describes where shared helpers or a thin orchestrator may remain. Suggested boundaries require review before changing exported interfaces.

Large cohesive modules, barrel files and single-purpose coordinators are valid. There is no file-length, line-count or branch-count trigger. Tests are omitted by default and may be included with `--include-tests`.

## Usage

```sh
bun run guards:bun module-cohesion --path ../my-project
bun run guards:strict:bun module-cohesion --path ../my-project
```
