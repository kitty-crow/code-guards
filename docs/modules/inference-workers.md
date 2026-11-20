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

Install an isolated Python environment with the published matching versions
`onnxruntime==1.31.0` and `onnxruntime-ep-webgpu==0.5.0`, plus
`huggingface-hub`, `tokenizers` and `numpy`. Set
`CODE_GUARDS_WEBGPU_PYTHON` to that Python executable. The native EP
supports `adapterIndex` and is distinct from the Node WebGPU binding.
Model sessions disable implicit CPU execution-provider fallback.

In PowerShell on KittyWin, create the environment (Python 3.12 required
for this example):

```powershell
py -3.12 -m venv "$env:TEMP\\code-guards-webgpu"
& "$env:TEMP\\code-guards-webgpu\\Scripts\\python.exe" -m pip install --upgrade pip
& "$env:TEMP\\code-guards-webgpu\\Scripts\\python.exe" -m pip install "onnxruntime==1.31.0" "onnxruntime-ep-webgpu==0.5.0" "huggingface-hub>=0.26,<2" "tokenizers>=0.20,<1" "numpy>=1.26,<3"
$env:CODE_GUARDS_WEBGPU_PYTHON = "$env:TEMP\\code-guards-webgpu\\Scripts\\python.exe"
```

First start will download the full FP32 MobileBERT ONNX model from Hugging
Face and will contribute to the 60-second scan deadline. For fair warm
benchmarks, prepopulate the cache before running the timed comparison.


The operation is **experimental**: native adapter enumeration, plugin
installation, the ONNX model's operator support, runtime results and score
parity must be verified on KittyWin before treating this mode as production
ready. A missing provider fails loudly and never silently falls back to
single-GPU WebGPU or CPU. No NVLink communication is required.

## Native WebGPU smoke test

After installing the Python plugin, run `bun run probe:dual-webgpu` on
KittyWin before any deadline-bounded TensorFlow scan. It sends an independent
semantic question to each adapter and prints the two verdicts. It now
propagates native stderr and handles worker stdin pipe closure safely, so
an adapter failure is reported rather than crashing Bun with EPIPE.

### Mixed CPU/WebGPU graph partitioning

MobileBERT contains operations that the native WebGPU provider assigns to
CPU. Strictly disabling CPU EP fallback prevents session creation. This
worker now allows supported CPU shape/control nodes, but does not permit
whole-session fallback if WebGPU execution fails. The first inference is
profiled via ONNX Runtime kernel events: the worker rejects CPU-only
execution, reports actual WebGPU/CPU node counts and operator names and
cleans up the temporary profile JSON. Later inferences avoid profiling
overhead. A separate model instance is still selected via physical
`adapterIndex` per worker.

## Single-adapter baseline and load balancing

An explicit `--gpu-ids 0` selects the same native ONNX WebGPU plugin and
MobileBERT implementation as `--gpu-ids 0,1`, but starts just one worker.
Both require `--accelerate batch,parallel,webgpu` with the same batch size,
concurrency and project settings for a fair 1 versus 2 GPU comparison.
The ordinary `--accelerate webgpu` mode uses a different Node ONNX backend,
so it should not be treated as the one-GPU native plugin baseline.

Across multiple workers, each incoming semantic question goes to the worker
with the smallest number of outstanding requests, rather than strict
round-robin assignment. Equal queue depths use a rotating tie-breaker.
This improves responsiveness when question lengths or GPU speeds differ,
while preserving the order of final guard findings. Workers still execute
their assigned questions independently; no NVLink communication occurs.
