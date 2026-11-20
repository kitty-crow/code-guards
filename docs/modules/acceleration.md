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
