/**
 * Read a block range, splitting it whenever the endpoint refuses it.
 *
 * Arc's public RPC caps `eth_getLogs` at an undocumented span that has already changed once
 * (20,000 blocks, then 5,000), and it says so with a generic "RPC Request failed" rather than
 * a range error. So this does not try to recognise a size error: any failure on a range wider
 * than `minSpan` is retried as two halves, sequentially, until the pieces succeed or are too
 * small to split, at which point the error is real and is thrown.
 *
 * The one failure that must NOT split is a rate limit. Arc answers bursts with "Request
 * exceeds defined limit" (or -32005 / 429), and splitting there doubles the request count
 * against an endpoint that just said "fewer, please". Those wait and retry the same range.
 *
 * Sequential on purpose, for the same reason.
 */

const RATE_LIMITED = /rate.?limit|exceeds defined limit|too many requests|-32005|\b429\b/i;

export function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${(error as {details?: string}).details ?? ""}` : String(error);
  return RATE_LIMITED.test(message);
}

export interface SplitOptions {
  /** Ranges at or under this many blocks are not split further. */
  minSpan?: bigint;
  /** Retries per range when rate-limited. */
  rateLimitRetries?: number;
  /** Base wait before a rate-limit retry; doubles each time. */
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readLogsSplitting<T>(
  read: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint,
  options: SplitOptions | bigint = {},
): Promise<T[]> {
  const {minSpan = 250n, rateLimitRetries = 6, backoffMs = 500} =
    typeof options === "bigint" ? {minSpan: options} : options;

  let attempt = 0;
  for (;;) {
    try {
      return await read(from, to);
    } catch (error) {
      if (isRateLimit(error) && attempt < rateLimitRetries) {
        await sleep(backoffMs * 2 ** attempt++);
        continue;
      }
      if (isRateLimit(error) || to - from + 1n <= minSpan) throw error;
      const mid = from + (to - from) / 2n;
      const left = await readLogsSplitting(read, from, mid, options);
      const right = await readLogsSplitting(read, mid + 1n, to, options);
      return [...left, ...right];
    }
  }
}
