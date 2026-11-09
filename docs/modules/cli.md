# Command-line interface

Source: [`src/cli.ts`](../../src/cli.ts)

`options` parses guard selection, `--disable`, `--strict`, output formatting and offline mode. `run` invokes the analysis engine and renders findings. The command returns 0 for an advisory scan, 1 for warnings under `--strict`, and 2 for loading or model errors.

## Behaviour and boundaries

The CLI entry point is `dist/src/cli.js` after building. It does not change the TypeScript compiler; strict mode fails the enclosing build or test script by exit status.
