# Multi-GPU CUDA worker pool

Sources: [`src/inference-workers.ts`](../../src/inference-workers.ts) and
[`src/inference-worker.ts`](../../src/inference-worker.ts).

With an explicit pair of GPU IDs, the scanner starts one subprocess per
selected CUDA card, setting `CUDA_VISIBLE_DEVICES` for each before loading
ONNX Runtime. Workers receive semantic questions through JSON-lines stdin and
return scored verdicts plus completed-inference telemetry on stdout. A failed
worker rejects pending requests without falling back to CPU.

Use `--accelerate parallel,cuda --concurrency 4 --gpu-ids 0,1` only on
Linux/WSL2 with native CUDA bindings and libraries available. There is no
equivalent validated physical-adapter selector for native Windows WebGPU
within the current Transformers.js pipeline. This architecture duplicates
models, not memory, and does not use or require NVLink.
