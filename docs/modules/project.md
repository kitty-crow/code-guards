# TypeScript project loader

Source: [`src/project.ts`](../../src/project.ts)

`loadProject` accepts a TypeScript configuration file, an existing directory or a single `.ts`, `.tsx`, `.mts` or `.cts` file. The returned `Project` contains `program`, `checker`, `root` and scanned source `files`. File paths in findings are relative to the selected target root, not the Code Guards checkout.

## Configuration and fallbacks

- Directory containing `tsconfig.json`: respect that configuration's `include`, `exclude`, `references` and compiler options as parsed by TypeScript.
- Directory without `tsconfig.json`: discover TypeScript files recursively, excluding `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.cache` and `out`. Use modern ES module defaults solely for static analysis.
- An individual `.ts`/`.tsx`/`.mts`/`.cts` file: scan only that source file, with its parent directory as the root.
- Explicit `tsconfig*.json`: use that configuration; missing or empty targets produce a diagnostic error (exit 2).

No files are copied into or modified in the target project. Excluded declaration files and libraries may still be loaded by TypeScript as supporting type information, but they are not inspected by guards.

## Usage

```sh
bun dist/src/cli.js --path ../another-project
bun dist/src/cli.js --path /absolute/path/to/project --strict
bun dist/src/cli.js --project ../another-project/tsconfig.json
bun dist/src/cli.js no-nested-if --path ../another-project/src/main.ts
```

`--path` and `--project` are alternative target selectors, not combinable. `--path` requires a pre-existing path; it cannot scan a remote Git URL or create a temporary clone.
