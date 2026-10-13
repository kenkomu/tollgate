/**
 * Read a block range, splitting it whenever the endpoint refuses it.
 *
 * Arc's public RPC caps `eth_getLogs` at an undocumented span that has already changed once
 * (20,000 blocks, then 5,000), and it says so with a generic "RPC Request failed" rather than
 * a range error. So this does not try to recognise the error: any failure on a range wider
 * than `minSpan` is retried as two halves, sequentially, until the pieces succeed or are too
 * small to split, at which point the error is real and is thrown.
 *
 * Sequential on purpose: a refused range is usually a rate or size limit, and firing both
 * halves at once is how a size problem becomes a rate-limit problem.
 */
export async function readLogsSplitting<T>(
  read: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint,
  minSpan = 250n,
): Promise<T[]> {
  try {
    return await read(from, to);
  } catch (error) {
    if (to - from + 1n <= minSpan) throw error;
    const mid = from + (to - from) / 2n;
    const left = await readLogsSplitting(read, from, mid, minSpan);
    const right = await readLogsSplitting(read, mid + 1n, to, minSpan);
    return [...left, ...right];
  }
}
