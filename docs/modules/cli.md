# Command-line interface

Source: [`src/cli.ts`](../../src/cli.ts)

`options` parses guard selection, `--disable`, `--strict`, external `--path`, `--project`, output formatting and offline mode. `run` invokes the analysis engine and renders findings. It exits 1 for errors in either mode or warnings in strict mode, 0 otherwise, and 2 for invalid targets or model-loading errors.

## Scan another project without installing Code Guards there

From the Code Guards checkout after `bun run build`:

```sh
bun dist/src/cli.js --path ../tracker-viewer
bun dist/src/cli.js --path ../tracker-viewer --strict
bun dist/src/cli.js --project ../tracker-viewer/tsconfig.json --format json
```

The `--path` selector accepts a directory, tsconfig file or individual TypeScript file, with or without a local tsconfig for directory targets. Relative paths resolve from the current working directory. `--project` remains an explicit tsconfig selector. Do not combine `--path` and `--project`.

## Behaviour and boundaries

The command-line executable is `dist/src/cli.js` after building. It reads the target project but does not write to it, install itself, modify `tsc` or run GitHub Actions. Optional local NLP inference can download model weights into the caller's cache on first use.

## Inference acceleration

`--accelerate none` preserves CPU/q8 model inference. Composable choices
are `cache`, `batch`, `cuda` and `webgpu`. Repeat `--accelerate` or
provide a comma-separated list. `--batch-size 2..16` requires batching.
GPU backends are alternatives selected in the order supplied; they never
silently fall back to CPU. The same flags are available to the Bun benchmark.

## Benchmark telemetry

`--benchmark-telemetry` is an internal scanner flag used by the
separate, hard-stop throughput supervisor. It emits prefixed JSON
on standard error for the scanner's project, stages and inference,
without changing the normal findings on standard output.
