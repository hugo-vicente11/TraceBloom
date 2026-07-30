/**
 * A tiny bounded-concurrency runner. Judge calls cost tokens and hit a rate-
 * limited API, so the runner never fans out unboundedly: at most `limit` tasks
 * are in flight at once (decision #4). No dependency needed for this.
 */

/** Run `tasks` with at most `limit` executing concurrently, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const bound = Math.max(1, Math.min(limit, items.length || 1));

  async function run(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: bound }, () => run()));
  return results;
}
