# Ordered inference scheduler

Source: [`src/inference-scheduler.ts`](../../src/inference-scheduler.ts)

`orderedConcurrentMap(items, concurrency, map)` launches at most
`concurrency` independent tasks at once, without allocating one Promise per
candidate. Results are written into their original input positions, so guard
findings and deterministic tests preserve order even when inference completes
out of order. The pool stops launching new tasks after an error and waits for
active work to settle before propagating the failure.

The `parallel` acceleration option activates the pool in type-reuse. This is
an in-process asynchronous scheduling optimisation, not GPU affinity, physical
GPU sharding, or NVLink transport. Verify performance on the actual hardware.

## Shared model session

The `parallel,batch` combination also activates
`createQuestionBatcher` in `src/semantic.ts`. Rather than invoking
the same GPU pipeline concurrently, questions share a round-robin queue.
Compatible evidence windows are grouped across questions, and only one
model call runs at a time. Returned verdicts still correspond to the
original question and window indices, and the guard reorders findings as
before. This does not use multiple GPUs, which require separate sessions
with verified device affinity.
