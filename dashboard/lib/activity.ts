import {
  MAX_HISTORY_BLOCKS,
  MAX_LOG_BLOCK_RANGE,
  POLICY_ENGINE_DEPLOY_BLOCK,
  explainToOwner,
  spendKey,
  type Reason,
} from "@tollgate/shared";
import {parseEventLogs, type Address} from "viem";
import {ENGINE, abi, publicClient} from "./chain.ts";

/**
 * Reads every PolicyEngine log in a block window, decoded.
 *
 * One request per window covering all four event types, rather than one request per
 * event type — Arc's public RPC rate-limits, and filtering server-side by event would
 * quadruple the request count for no benefit when we want all of them anyway.
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
 * view of a spend limit. It does not apply to history. A block that is behind the tip by
 * more than `CONFIRMATIONS` will never contain a different set of logs than it does now,
 * so re-reading it on every page load buys nothing and costs seven round trips.
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

/**
 * Walks the contract's history in windows.
 *
 * Arc refuses `eth_getLogs` beyond ~20,000 blocks and rate-limits bursts, so windows are
 * walked with bounded concurrency rather than fired all at once. Reading from genesis is
 * not slow here — it is refused — so we start at the deployment block.
 */
async function readAllLogs(head: bigint) {
  const deployed = BigInt(process.env.POLICY_ENGINE_DEPLOY_BLOCK ?? POLICY_ENGINE_DEPLOY_BLOCK);
  const earliest = head > MAX_HISTORY_BLOCKS ? head - MAX_HISTORY_BLOCKS : 0n;

  // Window boundaries are anchored to the deployment block, never to the moving head, so
  // that a given window has the same bounds on every load and stays cacheable. Windows
  // that fall entirely outside the history horizon are skipped rather than shifting the
  // grid, which would invalidate every key each time a block is produced.
  const windows: Array<{from: bigint; to: bigint}> = [];
  for (let from = deployed; from <= head; from += MAX_LOG_BLOCK_RANGE) {
    const to = from + MAX_LOG_BLOCK_RANGE - 1n;
    if (to < earliest) continue;
    windows.push({from, to: to > head ? head : to});
  }

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

/**
 * The audit log, rebuilt from chain.
 *
 * Every entry is derived from a contract event — nothing here is stored by us, so nothing
 * here can drift from what actually happened. Losing this server loses nothing.
 *
 * Entries carry an idempotency key of `tx_hash + log_index` per §3.5, so that a reorg or a
 * replayed read cannot double-count a payment.
 */

export type ActivityKind = "paid" | "payee-allowed" | "payee-removed" | "paused" | "resumed" | "policy-created";

export interface Activity {
  key: string;
  kind: ActivityKind;
  blockNumber: bigint;
  timestamp: number;
  txHash: string;
  /** Present on payments. */
  amount?: bigint;
  payee?: Address;
  agent?: Address;
  spentTotal?: bigint;
  availableAfter?: bigint;
}

export interface AuditLog {
  entries: Activity[];
  /** Allowlisted payees, folded up from PayeeSet events. */
  allowedPayees: Address[];
  paused: boolean;
}

/**
 * Reads the whole history for one owner, from the deployment block onward.
 */
export async function readAuditLog(owner: Address): Promise<AuditLog> {
  // One head read shared across the whole walk, so the log cannot show a half-updated
  // picture built from two different chain tips.
  const head = await publicClient.getBlockNumber();
  const all = await readAllLogs(head);

  // Filter to this owner here rather than in the RPC topic filter, since we fetch every
  // event type in one pass. One owner per deployment today; the registry in ADR 0004 is
  // where this becomes a real index.
  const mine = all.filter((log) => {
    const args = log.args as {owner?: Address};
    return args.owner?.toLowerCase() === owner.toLowerCase();
  });

  const spentLogs = mine.filter((l) => l.eventName === "Spent");
  const payeeLogs = mine.filter((l) => l.eventName === "PayeeSet");
  const pauseLogs = mine.filter((l) => l.eventName === "PauseSet");
  const createdLogs = mine.filter((l) => l.eventName === "PolicyCreated");

  const entries: Activity[] = [];

  for (const log of spentLogs) {
    const a = log.args as {agent?: Address; payee?: Address; amount?: bigint; spentTotal?: bigint; availableAfter?: bigint};
    entries.push({
      key: spendKey(log.transactionHash, log.logIndex),
      kind: "paid",
      blockNumber: log.blockNumber,
      timestamp: 0,
      txHash: log.transactionHash,
      amount: a.amount,
      payee: a.payee,
      agent: a.agent,
      spentTotal: a.spentTotal,
      availableAfter: a.availableAfter,
    });
  }

  const payeeState = new Map<Address, boolean>();
  for (const log of payeeLogs) {
    const a = log.args as {payee?: Address; allowed?: boolean};
    if (a.payee !== undefined) payeeState.set(a.payee, Boolean(a.allowed));
    entries.push({
      key: spendKey(log.transactionHash, log.logIndex),
      kind: a.allowed ? "payee-allowed" : "payee-removed",
      blockNumber: log.blockNumber,
      timestamp: 0,
      txHash: log.transactionHash,
      payee: a.payee,
    });
  }

  let paused = false;
  for (const log of pauseLogs) {
    const a = log.args as {paused?: boolean};
    paused = Boolean(a.paused);
    entries.push({
      key: spendKey(log.transactionHash, log.logIndex),
      kind: a.paused ? "paused" : "resumed",
      blockNumber: log.blockNumber,
      timestamp: 0,
      txHash: log.transactionHash,
    });
  }

  for (const log of createdLogs) {
    entries.push({
      key: spendKey(log.transactionHash, log.logIndex),
      kind: "policy-created",
      blockNumber: log.blockNumber,
      timestamp: 0,
      txHash: log.transactionHash,
    });
  }

  // Newest first. Ties broken by log index inside the key, which is already ordered.
  entries.sort((a, b) => (b.blockNumber === a.blockNumber ? b.key.localeCompare(a.key) : Number(b.blockNumber - a.blockNumber)));

  // Timestamps for the visible window only — one RPC call per block is not free. A block's
  // timestamp never changes, so each one is fetched at most once per process lifetime.
  const visible = entries.slice(0, 40);
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
  for (const entry of entries) {
    entry.timestamp = blockTimes.get(entry.blockNumber) ?? 0;
  }

  return {
    entries,
    allowedPayees: [...payeeState.entries()].filter(([, allowed]) => allowed).map(([payee]) => payee),
    paused,
  };
}

/** Plain English for the owner, per §5.1. */
export function describe(entry: Activity): string {
  switch (entry.kind) {
    case "paid":
      return "Payment allowed";
    case "payee-allowed":
      return "You approved a payee";
    case "payee-removed":
      return "You removed a payee";
    case "paused":
      return "You paused the agent";
    case "resumed":
      return "You resumed the agent";
    case "policy-created":
      return "Policy created";
  }
}

export function reasonText(reason: Reason): string {
  return explainToOwner(reason);
}
