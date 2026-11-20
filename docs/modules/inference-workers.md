# Multi-GPU inference worker pool

Sources: [`src/inference-workers.ts`](../../src/inference-workers.ts) and
[`src/inference-worker.ts`](../../src/inference-worker.ts).

With explicit GPU IDs, the scanner starts an independent model worker
subprocess for every selected GPU and forwards semantic questions through
JSON-lines IPC. Each worker returns scored verdicts and completed-inference
telemetry. Failures reject outstanding work instead of falling back to CPU.

On Linux/WSL2, `--accelerate parallel,cuda --concurrency 4 --gpu-ids 0,1`
uses `CUDA_VISIBLE_DEVICES` before initialising ONNX Runtime. On native
Windows, `--accelerate parallel,dml --concurrency 4 --gpu-ids 0,1`
uses ONNX Runtime DirectML's explicit adapter selection via `deviceId`.
Windows WebGPU still has no verified physical-adapter selection in this
integration. Neither approach uses NVLink, because the model is replicated
and no peer-to-peer tensor exchange is necessary.

## Windows DirectML mode

Use `--accelerate parallel,dml --gpu-ids 0,1 --concurrency 4` under
native Windows PowerShell. Each worker process passes the requested adapter
ID into the ONNX Runtime DirectML execution provider through Transformers.js
`session_options`. Separate worker subprocesses prevent two sessions from
accidentally sharing an unconfigured default WebGPU adapter. Run the
throughput benchmark and inspect `gpuWindows` plus GPU utilisation to
verify that both adapters actually executed work. Device ordinal ordering
may differ from `nvidia-smi`. Model precision is FP32.

DirectML workers set `enableMemPattern: false` and
`executionMode: 'sequential'` as required by ONNX Runtime. Cross-device
parallelism comes from separate inference sessions in separate processes,
not by calling a single DirectML session concurrently.
