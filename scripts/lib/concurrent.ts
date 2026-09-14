/** Bound simultaneous file reads while preserving input order for deterministic results. */
export async function mapConcurrent<T, R>(items: readonly T[], read: (item: T) => Promise<R>, limit = 4): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await read(items[index]!); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}
