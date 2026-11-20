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
