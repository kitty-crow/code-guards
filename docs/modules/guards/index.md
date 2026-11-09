# Guard exports

Source: [`src/guards/index.ts`](../../../src/guards/index.ts)

This entry module re-exports the implementation functions consumed by `analyse` in `src/engine.ts`: `noNestedIf`, `typeReuse`, `functionQuality`, `codeHealth`, `crossModule`, `documentation`, `repoHygiene`, `enterpriseLookingNaming` and `reviewPractices`.

Each guard accepts the loaded TypeScript `Project` or its repository root and returns findings with source locations, reasons and suggested corrections. Semantic guards may return a promise and can run local model inference. No guard rewrites user files. Use `--disable <guard>` in the CLI to opt out of a guard or `--strict` to reject warnings. The individual module pages document their specific inputs, options and limitations.
