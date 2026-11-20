
`gpuProviderProof` is collected from ONNX Runtime's first completed
inference profile on each native WebGPU worker. This distinguishes
registered-but-unused providers from actual GPU kernel execution,
while allowing partial CPU graph execution. The first profiled inference
is diagnostic and may be slower than later ones.
