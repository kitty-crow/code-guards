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

## Windows DirectML mode

Use `--accelerate parallel,dml --gpu-ids 0,1 --concurrency 4` under
native Windows PowerShell. Each worker process passes the requested adapter
ID into the ONNX Runtime DirectML execution provider through Transformers.js
`session_options`. Separate worker subprocesses prevent two sessions from
accidentally sharing an unconfigured default WebGPU adapter. Run the
throughput benchmark and inspect `gpuWindows` plus GPU utilisation to
verify that both adapters actually executed work. Device ordinal ordering
may differ from `nvidia-smi`. Model precision is FP32.
