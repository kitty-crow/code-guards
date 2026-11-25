# Deadline-bounded real-project benchmark

Source: [`scripts/benchmark-throughput.ts`](../../scripts/benchmark-throughput.ts)

Run `bun run benchmark:throughput --project /path/to/tsconfig.code-guards.json`
to compare real scans of an existing TypeScript project.
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
completed semantic questions and actual inference windows. The loaded-file count measures parsing.
The stage counter increments on completion; the inference counter tracks finished windows throughout the scan.

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
each require a working CUDA provider.
The JSON result includes `gpuWindows` per CUDA device to show whether both
workers actually handled inference. This mode is not available on native
Windows WebGPU.

On Linux/WSL2 the supervisor launches each scanner in a dedicated process
group and kills that entire group at the deadline, including any GPU workers
created beneath it. Native Windows DirectML uses a separate process tree;
the supervisor kills that tree using `taskkill.exe /T /F`.

The JSON summary now distinguishes actual ONNX/Transformers.js inference calls
from completed model windows. `crossQuestionBatches` counts calls that
include multiple independent questions, while `maximumBatchSize` records the
largest model call. A nonzero `crossQuestionBatches` is direct evidence that
`parallel,batch` grouped windows from different questions.

To measure explicit dual-DirectML adapter execution on Windows:

```powershell
bun run benchmark:throughput --project "$env:TEMP\\example-project\\tsconfig.code-guards.json" --mode dml --mode parallel,dml --gpu-ids 0,1 --concurrency 4
```

This reports work completed by each adapter and retains the 60-second
per-mode limit. The DirectML execution provider may have different throughput
and semantic confidence results from WebGPU or CPU.

For native Windows dual-DirectML mode, the benchmark supervisor uses
`taskkill.exe /T /F` at the deadline to terminate the scanner process
**and its model worker subprocesses**. Other platforms use the existing
POSIX process-group termination. If Windows process-tree termination fails,
the supervisor falls back to terminating the scanner itself.

### Physical WebGPU adapter comparison on Windows

The `--mode webgpu --mode parallel,webgpu --gpu-ids 0,1 --concurrency 4`
combination compares the existing single WebGPU model with the optional
adapter-index-aware native WebGPU plugin workers. Install the corresponding
Python ONNX Runtime plugin environment and set `CODE_GUARDS_WEBGPU_PYTHON`.
The report's `gpuWindows` tracks completed inference windows by physical
adapter index. See `docs/modules/inference-workers.md` for dependencies.
Because these modes use distinct ORT bindings, also verify numerical parity.

For the native WebGPU plugin, first-start model downloads are included in
the 60-second limit. To compare warm inference, prefetch the full FP32
`Xenova/mobilebert-uncased-mnli` model, configuration and tokenizer in
the same Python environment. Native plugin sessions disable CPU EP fallback;
unsupported WebGPU operators produce an explicit failure.


`gpuProviderProof` is collected from ONNX Runtime's first completed
inference profile on each native WebGPU worker. This distinguishes
registered-but-unused providers from actual GPU kernel execution,
while allowing partial CPU graph execution. The first profiled inference
is diagnostic and may be slower than later ones.

### Fair native WebGPU one-versus-two-adapter comparison

Run each command separately, retaining identical batch size and concurrency:

```powershell
bun run benchmark:throughput --project "$env:TEMP\\example-project\\tsconfig.code-guards.json" --mode batch,parallel,webgpu --gpu-ids 0 --concurrency 4 --batch-size 4
bun run benchmark:throughput --project "$env:TEMP\\example-project\\tsconfig.code-guards.json" --mode batch,parallel,webgpu --gpu-ids 0,1 --concurrency 4 --batch-size 4
```

This compares the same native plugin, model format and scoring path rather
than comparing Python WebGPU workers with a different Node/Transformers.js
execution provider. The benchmark's hard stop and per-device attribution
continue to apply. Work is assigned to the least-queued worker, not round
robin, to reduce idle time during heterogeneous semantic questions.
