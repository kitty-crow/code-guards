# Selectable inference acceleration

Source: [`src/acceleration.ts`](../../src/acceleration.ts)

`parseAccelerationFlags(argv)` extracts inference options and returns
the unconsumed CLI arguments along with an `AccelerationConfig`. The scanner
and benchmark share the same parsing and validation logic. Features are
retained in insertion order, allowing ordered GPU provider preferences.

## Options

| Selection | Behaviour |
| --- | --- |
| `none` | CPU with q8 weights, no optional optimisations |
| `cache` | In-memory result cache for repeated semantic questions |
| `batch` | Group two or more model windows into one pipeline call |
| `cuda` | Native CUDA provider via Transformers.js and ONNX Runtime where available |
| `webgpu` | GPU execution through the WebGPU provider where available |

`--accelerate cache,batch,webgpu --batch-size 4` combines independent
optimisations. `--accelerate cuda --accelerate webgpu` tries CUDA first and
then WebGPU only if CUDA fails to initialise. The model is not distributed
across both backends, and no GPU selection silently falls back to CPU.
Invalid names, nonsensical combinations and unsupported batch sizes fail.

GPU modes use FP32 model weights; CPU mode retains q8 weights.
Different precision and execution providers may alter confidence scores.
The code is not converted into WebAssembly as part of this feature.

## Bounded parallel questions

`parallel` enables a bounded, deterministic pool of independent semantic
comparison tasks. Use `--accelerate parallel,webgpu --concurrency 4` or combine
it with `cache` and `batch`. Without `parallel`, the analyser still
processes candidate pairs serially. `--concurrency` accepts 2 to 16 and
requires the flag. It limits outstanding tasks, not the GPU count.

The type-reuse guard currently schedules candidate comparisons in this
bounded pool and restores original candidate order before formatting findings.
This is same-process concurrency on the selected execution provider. It does
**not** bind work to a second physical GPU, create extra GPU sessions, or
exchange tensors over NVLink. Hardware acceleration should be verified using
per-device telemetry and a before/after throughput benchmark.

## Explicit dual-GPU CUDA workers (Linux/WSL2)

`--accelerate parallel,cuda --concurrency 4 --gpu-ids 0,1` starts one
independent model worker process for each selected NVIDIA GPU. Each receives
`CUDA_VISIBLE_DEVICES` set to its assigned physical index, making device
affinity explicit. Semantic questions are distributed across workers via
line-based IPC; each process loads its own copy of MobileBERT. Completed
windows from each worker are attributed to its GPU index in benchmark JSON.

This path requires a working native CUDA ONNX Runtime provider on Linux or
WSL2. It deliberately rejects native Windows, where this Transformers.js
integration cannot reliably bind separate WebGPU adapters. It is not NVLink
transport: the model is replicated and no intermediate tensors cross GPUs.

## Native Windows DirectML GPU affinity

The `dml` acceleration option selects ONNX Runtime's DirectML execution
provider (Windows). For explicit dual-GPU selection use
`--accelerate parallel,dml --gpu-ids 0,1 --concurrency 4`.
Each child process loads its own model, passing
`session_options.executionProviders = [{name:'dml', deviceId: GPU_ID}]`
to Transformers.js. ONNX Runtime selects the Windows DirectML adapter;
these device IDs follow DirectML/DXGI enumeration, not necessarily
`nvidia-smi` numbering. Unsupported devices fail explicitly rather than
falling back to another GPU or CPU. This is distinct from WebGPU acceleration,
which remains single-device unless adapter selection is implemented.

DirectML session options explicitly disable ONNX memory patterns and use
sequential session execution, as required by the DirectML execution provider.

`parallel,webgpu` with explicit `--gpu-ids` uses an optional **native
WebGPU plugin**, rather than treating ONNX's `deviceId` as a physical GPU.
The scanner remains Bun-based; the adapter-aware ONNX model sessions execute
in isolated local worker processes through the plugin's Python binding.
This requires optional separately installed Python dependencies and does not
change the default `webgpu` backend.

The native WebGPU bridge disables ONNX CPU EP fallback, so unsupported
operators fail explicitly rather than making per-GPU counters misleading.

Explicit `--gpu-ids` now accepts one or more unique adapters. Selecting one
adapter permits a like-for-like native WebGPU throughput baseline against
two adapters, while preserving the same Bun scheduler and Python plugin
implementation. The worker pool assigns new questions to the least-queued
adapter with rotating tie-breaks.
