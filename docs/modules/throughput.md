# Deadline-bounded real-project benchmark

Source: [`scripts/benchmark-throughput.ts`](../../scripts/benchmark-throughput.ts)

Run `bun run benchmark:throughput --project /path/to/tsconfig.code-guards.json`
to compare real scans of the TensorFlow TypeScript source tree.
The default runs three configurations: CPU/q8, WebGPU/FP32 and
WebGPU/FP32 with four-window batches.

Each mode starts a fresh Bun child process. Its timeout begins before
TypeScript project loading and includes all scan startup overhead.
A separate supervising process forcibly terminates the child after
60 seconds (the default), including during synchronous AST work or
native inference. Scans that finish early are recorded as completed.

`--mode` can be repeated to select another acceleration configuration;
`--batch-size 2..16` adjusts batched modes, while `--guard type-reuse`
targets that specific guard. `--seconds` overrides the wall-clock
deadline for testing. All 23 guards are enabled by default.

The child uses the private `--benchmark-telemetry` flag to emit
structured progress events on standard error. The supervisor discards
normal findings and reports completed guard stages, their findings,
completed semantic questions and actual inference windows. Loaded
source-file counts are explicitly *not* presented as coverage.
A stage in progress at termination is not counted as completed,
even though completed inference inside it is counted.

WebGPU uses FP32, CPU uses q8, so result quality is not necessarily
identical. GPU hardware, model loading, caches and machine activity
may affect measurements. No results are claimed until the benchmark
has actually run on the target machine.

To compare independent-question parallelism on the same machine:

```sh
bun run benchmark:throughput --project /path/to/tsconfig.code-guards.json --mode webgpu --mode parallel,webgpu --mode batch,parallel,webgpu --concurrency 4
```

`--concurrency` controls the limit for modes that include `parallel`. This
isolates queueing benefits from model precision and GPU selection.
