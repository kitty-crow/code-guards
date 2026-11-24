# TypeScript project loader

Source: [`src/project.ts`](../../src/project.ts)

`loadProject` accepts a TypeScript configuration file, an existing directory or a single `.ts`, `.tsx`, `.mts` or `.cts` file. The returned `Project` contains `program`, `checker`, `root` and scanned source `files`. File paths in findings are relative to the selected target root, not the Code Guards checkout.

## Configuration and fallbacks

- Directory containing `tsconfig.json`: respect that configuration's `include`, `exclude`, `references` and compiler options as parsed by TypeScript.
- Directory without `tsconfig.json`: discover TypeScript files recursively, excluding dependency and output directories such as `node_modules`, `vendor`, `third_party`, `.git`, `dist`, `build`, `coverage`, `.next`, `.cache` and `out`. Use modern ES module defaults solely for static analysis.
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

## Target selectors

| Selector | Use |
| --- | --- |
| `--path` | Existing local file or directory |
| `--project` | TypeScript configuration file |

Choose one selector per command. Remote Git URLs and automatic cloning are unsupported.

## Vendored dependencies

`vendoredPaths(root)` reads submodule paths declared in the target repository's `.gitmodules` and returns a read-only set of relative path prefixes. It does not clone or initialise those dependencies.

`isVendoredPath(root, filename, submodules)` identifies files inside `vendor/`, `third_party/`, `third-party/` or any declared submodule path, including custom locations outside the conventional vendor directories. `createProject` removes these sources from the TypeScript root names and analysed files, including when a broad `tsconfig` glob would otherwise include them. TypeScript may still resolve imported declarations as supporting type information, but guards do not inspect vendored files.

`isTestFile(filename)` recognises test directories and dot, underscore or hyphen suffixes such as `tensor_test.ts` and `tensor-spec.ts`.
