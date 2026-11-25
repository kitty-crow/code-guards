# Physical GPU memory monitoring

Source: [src/gpu-memory.ts](../../src/gpu-memory.ts)

`parseMemoryMap` validates the mapping between provider adapter ordinals and physical GPU UUIDs. It requires exactly one unique physical device per selected adapter. `readNvidiaMemory` obtains `DeviceMemory` readings in MiB via the NVIDIA driver utility. It rejects malformed data or a failed query.

`GpuMemoryMonitor` accepts a `MemoryReader` and optional absolute device budget. Its `sample` method emits a `DeviceMemorySample` for each mapped adapter, including baseline and highest sampled use. The `MemoryPhase` identifies readings before model allocation, during inference and after worker exit. The limit applies before and during execution. Readings after exit are reported to assess release, rather than assumed from session disposal.

`configuredGpuMemoryMonitor` activates monitoring only when an explicit mapping is supplied. See the [worker pool configuration](inference-workers.md). Missing driver telemetry is an operational error when monitoring is requested. The measurements include all GPU clients, and transient peaks between samples are not observed.
