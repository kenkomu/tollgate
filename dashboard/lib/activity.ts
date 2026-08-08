import {POLICY_ENGINE_DEPLOY_BLOCK} from "@tollgate/shared";
import {parseEventLogs, type Address} from "viem";
import {ENGINE, abi, publicClient} from "./chain.ts";
import {planWindows, projectAuditLog, type AuditLog, type EngineLog} from "./audit.ts";

export {describe, reasonText} from "./audit.ts";
export type {Activity, ActivityKind, AuditLog} from "./audit.ts";

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
  const logs = await publicClient.getLogs({address: ENGINE, fromBlock: from, toBlock: to});
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

/** Walks the contract's history in windows, with bounded concurrency. */
async function readAllLogs(head: bigint) {
  const deployed = BigInt(process.env.POLICY_ENGINE_DEPLOY_BLOCK ?? POLICY_ENGINE_DEPLOY_BLOCK);
  const windows = planWindows(deployed, head);

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
        if (settled) settledWindows.set(key, logs);
        return logs;
      }),
    );
    for (const logs of results) out.push(...logs);
  }
  return out;
}

/** Reads the whole history for one owner, from the deployment block onward. */
export async function readAuditLog(owner: Address): Promise<AuditLog> {
  // One head read shared across the whole walk, so the log cannot show a half-updated
  // picture built from two different chain tips.
  const head = await publicClient.getBlockNumber();
  const all = await readAllLogs(head);

  const audit = projectAuditLog(all as unknown as EngineLog[], owner);

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
