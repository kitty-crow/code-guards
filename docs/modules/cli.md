# Command-line interface

Source: [`src/cli.ts`](../../src/cli.ts)

`options` parses guard selection, `--disable`, `--strict`, external `--path`, `--project`, output formatting and offline mode. `run` invokes the analysis engine and renders findings. It exits 0 on advisory scans, 1 for warnings with `--strict`, and 2 on invalid targets or model-loading errors.

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
