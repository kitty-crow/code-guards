# Dedicated GPU model worker

Source: [`src/inference-worker.ts`](../../src/inference-worker.ts)

The GPU pool launches this module as a child process. It validates adapter settings and reads JSON lines from standard input.

## Inputs, outputs and failure behaviour

The parent provides `CODE_GUARDS_GPU_WORKER_ID`, `CODE_GUARDS_GPU_BACKEND` (`cuda` or `dml`), `CODE_GUARDS_GPU_BATCH_SIZE`, `CODE_GUARDS_GPU_BATCH` and `CODE_GUARDS_GPU_CACHE`. Requests contain a numeric ID and a semantic question with premise, supporting hypothesis and opposing hypothesis. Results and timing/ready notifications are emitted as JSON lines. Malformed requests or scoring errors emit a fatal result and stop the worker, leaving the parent to reject outstanding questions.

The entry point delegates semantic classification to `zeroShot` and uses the selected adapter. It is **not** started by `--preflight`, whose counting scorer runs in-process and does not load any model weights or GPU sessions.

CUDA and DirectML requests retain optional paired evidence. At EOF the worker disposes of its local inference session before exiting.
