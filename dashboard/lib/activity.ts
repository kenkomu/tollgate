import {
  POLICY_ENGINE_DEPLOY_BLOCK,
  auditFromActivity,
  planWindows,
  projectAuditLog,
  readLogsSplitting,
  type Activity,
  type AuditLog,
  type EngineLog,
} from "@tollgate/shared";
import {parseEventLogs, type Address} from "viem";
import {ENGINE, abi, publicClient} from "./chain.ts";
import {loadWindows, saveWindows} from "./logcache.ts";

export {describe, reasonText} from "@tollgate/shared";
export type {Activity, ActivityKind, AuditLog} from "@tollgate/shared";

/**
 * Reading the audit log from chain.
 *
 * This file owns the network: the windowed log walk, the retry policy, and the cache. The
 * projection itself — logs in, audit log out — lives in `audit.ts`, where it is testable
 * without a chain.
 */

/**
 * Reads every PolicyEngine log in a block window, decoded.
 *
 * One request per window covering all four event types, rather than one request per event
 * type — Arc's public RPC rate-limits, and filtering server-side by event would quadruple
 * the request count for no benefit when we want all of them anyway.
 */
async function readWindow(from: bigint, to: bigint) {
  const logs = await readLogsSplitting(
    (fromBlock, toBlock) => publicClient.getLogs({address: ENGINE, fromBlock, toBlock}),
    from,
    to,
  );
  return parseEventLogs({abi, logs, strict: false});
}

type DecodedLogs = Awaited<ReturnType<typeof readWindow>>;

/**
 * Settled history, memoised.
 *
 * "Always read fresh" applies to the *policy* — a cached view of a spend limit is a wrong
 * view of a spend limit. It does not apply to history. A block behind the tip by more than
 * `CONFIRMATIONS` will never contain a different set of logs than it does now, so
 * re-reading it on every page load buys nothing and costs seven round trips.
 *
 * Only the window containing the unstable tip is re-fetched. Losing this cache loses
 * nothing: it repopulates from chain, which remains the only authority.
 */
const settledWindows = new Map<string, DecodedLogs>();
const blockTimes = new Map<bigint, number>();

/**
 * Rehydrated from disk once per process, so a restart does not re-walk all of history.
 *
 * Awaited rather than fired and forgotten: a request that starts before the load finishes
 * would miss every cached window and do the full walk anyway, which is precisely the case
 * this exists to prevent — the first load after starting the server.
 */
let hydrated: Promise<void> | null = null;
let dirty = false;

function hydrate(): Promise<void> {
  hydrated ??= loadWindows<DecodedLogs>().then((stored) => {
    for (const [key, logs] of stored) if (!settledWindows.has(key)) settledWindows.set(key, logs);
  });
  return hydrated;
}

/** How far behind the tip a block must be before we treat its logs as final. */
const CONFIRMATIONS = 64n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries on Arc's `-32005 rate limit exceeded`, which a public endpoint will return. */
async function withBackoff<T>(work: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      await sleep(250 * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * How much history the chain fallback reads: about a day at Arc's ~2 blocks a second.
 *
 * The full walk from the deployment block is now thousands of requests (Arc cut its log span
 * to 5,000 blocks), which is minutes on a first load. With the service running the full
 * history comes from its index instead; without it, this reads a bounded recent window and the
 * result is marked `partialFrom` so every page says it is incomplete. A shortened log is only
 * acceptable when it says so.
 */
const FALLBACK_HISTORY_BLOCKS = 200_000n;

/** Walks the contract's history in windows, with bounded concurrency. */
async function readAllLogs(head: bigint, maxHistory: bigint = head) {
  await hydrate();

  const deployed = BigInt(process.env.POLICY_ENGINE_DEPLOY_BLOCK ?? POLICY_ENGINE_DEPLOY_BLOCK);

  /**
   * The whole history, with no horizon.
   *
   * `MAX_HISTORY_BLOCKS` existed because re-walking history on every page load was the cost
   * that made a horizon necessary. The persistent settled-window cache removes that: each
   * window is read once for the lifetime of the deployment, so walking from the deployment
   * block is a one-time linear cost rather than a per-request one.
   *
   * Removing it also fixes a silent data loss. Arc produces roughly two blocks a second, so
   * 400,000 blocks is about two and a half days — and this deployment had already passed it.
   * The three windows holding the first payments ever made were being skipped, and the audit
   * log was quietly shortening from the front with nothing to indicate it. For a log whose
   * entire purpose is evidence, dropping the oldest evidence without saying so is the worst
   * available behaviour.
   *
   * This grows with chain age. When it stops being reasonable, the answer is the indexer in
   * plan §2.3 — not a horizon that discards history.
   */
  const windows = planWindows(deployed, head, maxHistory);

  const CONCURRENCY = 3;
  const out: DecodedLogs = [];
  for (let i = 0; i < windows.length; i += CONCURRENCY) {
    const batch = windows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({from, to}) => {
        const settled = to + CONFIRMATIONS <= head;
        const key = `${from}:${to}`;
        if (settled) {
          const hit = settledWindows.get(key);
          if (hit) return hit;
        }
        const logs = await withBackoff(() => readWindow(from, to));
        if (settled) {
          settledWindows.set(key, logs);
          dirty = true;
        }
        return logs;
      }),
    );
    for (const logs of results) out.push(...logs);
  }

  // Written after the walk rather than per window, so one page load costs one write.
  if (dirty) {
    dirty = false;
    void saveWindows(settledWindows);
  }

  return out;
}

const SERVICE_URL = process.env.TOLLGATE_SERVICE_URL ?? "http://localhost:8080";

/** If the index is further behind than this, it is still backfilling: read the chain instead. */
const MAX_INDEX_LAG = 50_000n;

/** The service's JSON renders bigints as strings. Put them back. */
function reviveActivity(row: Record<string, unknown>): Activity {
  const big = (v: unknown) => (v === undefined || v === null ? undefined : BigInt(v as string));
  const detail = row.detail as {label: string; values: string[]} | undefined;
  return {
    ...(row as unknown as Activity),
    blockNumber: BigInt(row.blockNumber as string),
    amount: big(row.amount),
    spentTotal: big(row.spentTotal),
    availableAfter: big(row.availableAfter),
    // Without this every indexed row would belong to no agent, and per-agent views would
    // show only the owner-wide events.
    policyId: big(row.policyId),
    detail: detail ? {label: detail.label, values: detail.values.map((v) => BigInt(v))} : undefined,
  };
}

/** Indexed history from the service, or null if it is not running or not caught up. */
async function fromService(head: bigint): Promise<{indexedThrough: bigint; entries: Activity[]} | null> {
  try {
    const response = await fetch(`${SERVICE_URL}/activity?limit=10000`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {indexedThrough: string | number | null; entries: Record<string, unknown>[]};
    if (body.indexedThrough === null) return null;
    const indexedThrough = BigInt(body.indexedThrough);
    if (head - indexedThrough > MAX_INDEX_LAG) return null;
    return {indexedThrough, entries: body.entries.map(reviveActivity)};
  } catch {
    return null;
  }
}

/**
 * Reads the whole history for one owner.
 *
 * Fast path: the service has already indexed every settled block, so this asks it for the
 * history and reads only the unindexed tip (a few dozen blocks) from chain. That turns a
 * cold page load from thousands of `eth_getLogs` calls into one HTTP request and one small
 * log read. The chain is still the authority: the service only stores decoded contract
 * events, and the tip it has not reached yet comes straight from Arc.
 *
 * Slow path, when the service is down or still backfilling: walk the chain from the
 * deployment block, as before.
 */
export async function readAuditLog(owner: Address): Promise<AuditLog> {
  // One head read shared across the whole read, so the log cannot show a half-updated
  // picture built from two different chain tips.
  const head = await publicClient.getBlockNumber();

  const indexed = await fromService(head);
  let audit: AuditLog;
  if (indexed) {
    const tipFrom = indexed.indexedThrough + 1n;
    const tipLogs = tipFrom <= head ? await withBackoff(() => readWindow(tipFrom, head)) : [];
    const tip = projectAuditLog(tipLogs as unknown as EngineLog[], owner);
    audit = auditFromActivity([...indexed.entries, ...tip.entries]);
  } else {
    const all = await readAllLogs(head, FALLBACK_HISTORY_BLOCKS);
    audit = projectAuditLog(all as unknown as EngineLog[], owner);
    const deployed = BigInt(process.env.POLICY_ENGINE_DEPLOY_BLOCK ?? POLICY_ENGINE_DEPLOY_BLOCK);
    if (head - FALLBACK_HISTORY_BLOCKS > deployed) audit.partialFrom = head - FALLBACK_HISTORY_BLOCKS;
  }

  // Timestamps for the visible window only — one RPC call per block is not free. A block's
  // timestamp never changes, so each one is fetched at most once per process lifetime.
  const visible = audit.entries.slice(0, 40);
  const missing = [...new Set(visible.map((e) => e.blockNumber))].filter((n) => !blockTimes.has(n));
  await Promise.all(
    missing.map(async (n) => {
      try {
        const block = await publicClient.getBlock({blockNumber: n});
        blockTimes.set(n, Number(block.timestamp));
      } catch {
        // A missing timestamp degrades the display, never the record.
      }
    }),
  );
  for (const entry of audit.entries) {
    entry.timestamp = blockTimes.get(entry.blockNumber) ?? 0;
  }

  return audit;
}
