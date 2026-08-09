import {MAX_HISTORY_BLOCKS, MAX_LOG_BLOCK_RANGE} from "./chain.ts";
import {spendKey} from "./policy.ts";
import {explainToOwner, type Reason} from "./reasons.ts";
import type {Address} from "viem";

/**
 * The audit log, as pure functions.
 *
 * Separated from `activity.ts` — which owns the RPC calls and the cache — because these two
 * pieces are the ones that can be wrong in ways nobody notices. A window planner that drops
 * a range silently loses payments from the owner's history; a projection that folds payee
 * events in the wrong order shows an allowlist that does not match the contract's. Neither
 * failure raises an error. Both are trivially testable once they do not need a chain.
 *
 * This is also the shape the indexer in plan §2.3 needs: given logs, produce the projection.
 * Where it lands, it should call these rather than reimplement them.
 */

/**
 * Every kind of thing that can appear in the log.
 *
 * `PolicyEngine` emits ten events and this once covered five of them, silently dropping every
 * change the *owner* made to the leash — a raised budget, a widened rate limit, a rotated
 * agent key, a revoked policy. Those are not incidental: "the cap went from $10 to $20 an hour
 * before the big payment" is exactly the sequence an audit log exists to make visible, and it
 * was invisible. An evidence log that records only what the agent did, and not what the rules
 * were at the time, cannot answer the question it is there to answer.
 */
export type ActivityKind =
  | "paid"
  | "refused"
  | "payee-allowed"
  | "payee-removed"
  | "paused"
  | "resumed"
  | "policy-created"
  | "caps-changed"
  | "velocity-changed"
  | "expiry-changed"
  | "agent-rotated"
  | "policy-revoked";

export interface Activity {
  key: string;
  kind: ActivityKind;
  blockNumber: bigint;
  timestamp: number;
  txHash: string;
  /**
   * Present on payments.
   *
   * Spelled `?: T | undefined` rather than `?: T` because this package compiles with
   * `exactOptionalPropertyTypes`. A decoded log with `strict: false` genuinely can carry an
   * absent field, and the stricter reading is the honest one: "this key may be present and
   * hold undefined" is what actually happens when an event shape changes under us.
   */
  amount?: bigint | undefined;
  payee?: Address | undefined;
  agent?: Address | undefined;
  spentTotal?: bigint | undefined;
  availableAfter?: bigint | undefined;
  /** Present on refusals — why the contract said no. */
  reason?: Reason | undefined;
  /**
   * The new values, on an owner policy change.
   *
   * Two numbers on caps and velocity, one on expiry. Kept generic rather than one field per
   * event so a future rule does not need a schema change everywhere this is stored.
   */
  detail?: {label: string; values: bigint[]} | undefined;
  /** On a rotation, the key that was replaced. */
  previousAgent?: Address | undefined;
}

export interface AuditLog {
  entries: Activity[];
  /** Allowlisted payees, folded up from PayeeSet events. */
  allowedPayees: Address[];
  paused: boolean;
}

/** The subset of a decoded log this projection reads. */
export interface EngineLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

/**
 * Plan the `eth_getLogs` windows covering the contract's history.
 *
 * Two constraints shape this. Arc refuses ranges beyond ~20,000 blocks — the error claims
 * 100,000, and probing showed 50,000 refused — so the walk must be chunked. And boundaries
 * are anchored to the deployment block rather than to the moving head, so a given window has
 * identical bounds on every call and stays cacheable; anchoring to the head would invalidate
 * every cache key each time Arc produced a block, which at sub-second finality is constantly.
 */
export function planWindows(
  deployed: bigint,
  head: bigint,
  maxHistory: bigint = MAX_HISTORY_BLOCKS,
  span: bigint = MAX_LOG_BLOCK_RANGE,
): Array<{from: bigint; to: bigint}> {
  const earliest = head > maxHistory ? head - maxHistory : 0n;
  const windows: Array<{from: bigint; to: bigint}> = [];

  for (let from = deployed; from <= head; from += span) {
    const to = from + span - 1n;
    // Skip windows entirely outside the horizon rather than shifting the grid.
    if (to < earliest) continue;
    windows.push({from, to: to > head ? head : to});
  }

  return windows;
}

/**
 * Fold decoded contract logs into the owner's audit log.
 *
 * Every entry derives from an event, so nothing here can drift from what actually happened.
 * Entries carry an idempotency key of `tx_hash + log_index` per §3.5, so a reorg or a
 * replayed read cannot double-count a payment.
 *
 * Timestamps are left at 0 — they need a block read, which is the caller's business.
 */
export function projectAuditLog(logs: readonly EngineLog[], owner: Address): AuditLog {
  // Filtered here rather than in an RPC topic filter, because every event type is fetched
  // in one pass. One owner per deployment today; ADR 0004's registry is where this becomes
  // a real index.
  const mine = logs.filter(
    (log) => String(log.args.owner ?? "").toLowerCase() === owner.toLowerCase(),
  );

  const entries: Activity[] = [];
  const payeeState = new Map<Address, boolean>();
  let paused = false;

  for (const log of mine) {
    const a = log.args as {
      agent?: Address;
      payee?: Address;
      amount?: bigint;
      spentTotal?: bigint;
      availableAfter?: bigint;
      reason?: number;
      allowed?: boolean;
      paused?: boolean;
      budgetCap?: bigint;
      perTxCap?: bigint;
      bucketCapacity?: bigint;
      refillPerSecond?: bigint;
      expiry?: bigint;
      newAgent?: Address;
      previousAgent?: Address;
    };

    const base = {
      key: spendKey(log.transactionHash, log.logIndex),
      blockNumber: log.blockNumber,
      timestamp: 0,
      txHash: log.transactionHash,
    };

    switch (log.eventName) {
      case "Spent":
        entries.push({
          ...base,
          kind: "paid",
          amount: a.amount,
          payee: a.payee,
          agent: a.agent,
          spentTotal: a.spentTotal,
          availableAfter: a.availableAfter,
        });
        break;

      // Attempts the contract turned away. These exist only because the agent calls
      // `trySpend` — a reverted `spend` takes its own logs down with it — so an empty list
      // means either nothing was refused or the caller chose the silent path, never that a
      // refusal was lost.
      case "Refused":
        entries.push({
          ...base,
          kind: "refused",
          amount: a.amount,
          payee: a.payee,
          agent: a.agent,
          reason: a.reason as Reason | undefined,
        });
        break;

      case "PayeeSet":
        if (a.payee !== undefined) payeeState.set(a.payee, Boolean(a.allowed));
        entries.push({...base, kind: a.allowed ? "payee-allowed" : "payee-removed", payee: a.payee});
        break;

      case "PauseSet":
        paused = Boolean(a.paused);
        entries.push({...base, kind: a.paused ? "paused" : "resumed"});
        break;

      case "PolicyCreated":
        entries.push({...base, kind: "policy-created"});
        break;

      // The owner changing the rules. Recorded with the new values, because "caps changed"
      // without the numbers tells a reader that something moved and not whether it mattered.
      case "CapsUpdated":
        entries.push({
          ...base,
          kind: "caps-changed",
          detail: {label: "budget / per-payment", values: [a.budgetCap ?? 0n, a.perTxCap ?? 0n]},
        });
        break;

      case "VelocityUpdated":
        entries.push({
          ...base,
          kind: "velocity-changed",
          detail: {
            label: "burst / refill per second",
            values: [a.bucketCapacity ?? 0n, a.refillPerSecond ?? 0n],
          },
        });
        break;

      case "ExpiryUpdated":
        entries.push({
          ...base,
          kind: "expiry-changed",
          detail: {label: "expiry", values: [a.expiry ?? 0n]},
        });
        break;

      case "AgentRotated":
        entries.push({
          ...base,
          kind: "agent-rotated",
          agent: a.newAgent,
          previousAgent: a.previousAgent,
        });
        break;

      case "PolicyRevoked":
        entries.push({...base, kind: "policy-revoked", agent: a.agent});
        break;
    }
  }

  // Newest first. Ties broken by the log index inside the key, which is already ordered.
  entries.sort((x, y) =>
    y.blockNumber === x.blockNumber
      ? y.key.localeCompare(x.key)
      : Number(y.blockNumber - x.blockNumber),
  );

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
    case "refused":
      return "Payment refused";
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
    case "caps-changed":
      return "You changed the spending limits";
    case "velocity-changed":
      return "You changed the rate limit";
    case "expiry-changed":
      return "You changed when access expires";
    case "agent-rotated":
      return "You replaced the agent key";
    case "policy-revoked":
      return "You revoked the policy";
  }
}

export function reasonText(reason: Reason): string {
  return explainToOwner(reason);
}
