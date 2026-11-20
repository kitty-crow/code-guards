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

For experimental dual-GPU CUDA execution under Linux/WSL2, add
`--mode parallel,cuda --gpu-ids 0,1 --concurrency 4`. CUDA model workers
must be independently loadable; unsupported installations fail explicitly.
The JSON result includes `gpuWindows` per CUDA device to show whether both
workers actually handled inference. This mode is not available on native
Windows WebGPU.

On Linux/WSL2 the supervisor launches each scanner in a dedicated process
group and kills that entire group at the deadline, including any GPU workers
created beneath it. On native Windows a scan does not support the external
CUDA worker pool and the supervisor kills the scan process directly.

The JSON summary now distinguishes actual ONNX/Transformers.js inference calls
from completed model windows. `crossQuestionBatches` counts calls that
include multiple independent questions, while `maximumBatchSize` records the
largest model call. A nonzero `crossQuestionBatches` is direct evidence that
`parallel,batch` grouped windows from different questions.

To measure explicit dual-DirectML adapter execution on Windows:

```powershell
bun run benchmark:throughput --project "$env:TEMP\\tensorflow-ts-benchmark\\tsconfig.code-guards.json" --mode dml --mode parallel,dml --gpu-ids 0,1 --concurrency 4
```

This reports work completed by each adapter and retains the 60-second
per-mode limit. The DirectML execution provider may have different throughput
and semantic confidence results from WebGPU or CPU.

For native Windows dual-DirectML mode, the benchmark supervisor uses
`taskkill.exe /T /F` at the deadline to terminate the scanner process
**and its model worker subprocesses**. Other platforms use the existing
POSIX process-group termination. If Windows process-tree termination fails,
the supervisor falls back to terminating the scanner itself.
