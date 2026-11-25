# Physical embedding workers

Source: [src/expert-gpu.ts](../../src/expert-gpu.ts)

`configuredExpertGpu` selects a native WebGPU `ExpertGpu` configuration using the adapter ordinal, physical UUID, absolute device memory limit and Python runtime. Set these environment variables:

| Variable | Value |
| --- | --- |
| `CODE_GUARDS_EXPERT_GPU_ADAPTER` | Dawn adapter ordinal |
| `CODE_GUARDS_EXPERT_GPU_UUID` | Physical NVIDIA GPU UUID |
| `CODE_GUARDS_EXPERT_GPU_BUDGET_MIB` | Absolute used-memory limit in MiB |
| `CODE_GUARDS_WEBGPU_PYTHON` | Native worker Python executable (optional) |

`validateExpertAdapter` permits a CPU judge or explicit native WebGPU judge adapters with separate UUIDs, checked using the existing judge memory map. Other GPU provider combinations are rejected because cross-provider ordinal equality cannot establish physical identity.

`openGpuEmbeddingRuntime` uses the pinned checkpoint and returns an isolated batch runtime. `decodeEmbeddingRows` validates finite values, dimensions and unresolved overlength inputs. The worker verifies actual WebGPU kernels through the native profiler, performs masked mean pooling and normalisation, and terminates on failure rather than selecting another provider. GPU memory is sampled before loading, during operation and after process exit. Cache keys include the native provider versions and physical device.

CPU remains the default when no expert GPU adapter is configured. The GPU pathway requires real compatibility and performance measurements before default use.
