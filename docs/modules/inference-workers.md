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

## Native dual-WebGPU adapter workers

The current native Windows ONNX Runtime Node binding does not expose physical
Dawn adapter enumeration. ORT's separately packaged WebGPU plugin **does**
provide `adapterIndex`; it must not be confused with `deviceId`, a context ID.

The opt-in `--accelerate parallel,webgpu --gpu-ids 0,1 --concurrency 4`
mode therefore starts independent Python WebGPU plugin worker processes
(`scripts/native-webgpu-worker.py`), while the entire scanner, guard logic,
scheduling and telemetry remain in Bun/TypeScript. Each worker sets
`adapterIndex` through the native ONNX Runtime plugin and runs the exact
MobileBERT ONNX model and Hugging Face tokenizer. The workers return scored
semantic verdicts and per-adapter completed-inference telemetry.

Install an isolated Python environment containing `onnxruntime==1.32.0`,
the compatible `onnxruntime-ep-webgpu` plugin, `huggingface-hub` and
`tokenizers`, then set `CODE_GUARDS_WEBGPU_PYTHON` to that environment's
Python executable. ORT 1.32 uses a plugin EP distinct from the Node binding,
and the WebGPU plugin must match the core runtime version.

The operation is **experimental**: native adapter enumeration, plugin
installation, the ONNX model's operator support, runtime results and score
parity must be verified on KittyWin before treating this mode as production
ready. A missing provider fails loudly and never silently falls back to
single-GPU WebGPU or CPU. No NVLink communication is required.
