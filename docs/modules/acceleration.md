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
