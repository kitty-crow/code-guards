# TypeScript project loader

Source: [`src/project.ts`](../../src/project.ts)

`loadProject` reads a tsconfig, expands files using TypeScript’s parser and creates a `Project` with `program`, `checker`, `root` and source `files`.

## Behaviour and boundaries

The loader ignores declaration files and sources under node_modules. Other files are selected by the project’s tsconfig and each guard’s own exclusions.
