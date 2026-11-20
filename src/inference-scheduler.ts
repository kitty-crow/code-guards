/** Bounded async worker pool with deterministic result ordering. */

/**
 * Schedule independent work without allocating one pending Promise per item.
 * Rejected tasks propagate after active workers settle; no new tasks are
 * scheduled after the first failure.
 */
export async function orderedConcurrentMap<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("Inference concurrency must be between 1 and 16.");
  }
  if (!items.length) return [];
  const output: R[] = new Array<R>(items.length);
  let cursor = 0;
  let failure: unknown;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) throw new Error("Inference work queue contains an empty item.");
      try {
        output[index] = await map(item, index);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  if (failed) throw failure;
  return output;
}
