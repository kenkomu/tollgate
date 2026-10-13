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
  | "policy-revoked"
  | "fleet-paused"
  | "fleet-resumed";

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
  /**
   * Which policy (which agent) this happened to. Absent on owner-wide events, the fleet
   * pause, which apply to every policy at once; and on refusals for an unbound key.
   */
  policyId?: bigint | undefined;
}

/** True for events that belong to every one of the owner's policies at once. */
export function isOwnerWide(entry: Pick<Activity, "kind">): boolean {
  return entry.kind === "fleet-paused" || entry.kind === "fleet-resumed";
}

/** Does this row belong in the log of one policy? Its own events, plus owner-wide ones. */
export function belongsTo(entry: Pick<Activity, "kind" | "policyId">, policyId: bigint): boolean {
  return isOwnerWide(entry) || entry.policyId === policyId;
}

export interface AuditLog {
  entries: Activity[];
  /**
   * Allowlisted payees, folded up from PayeeSet events. Scoped to one policy when the log
   * was built for one; otherwise every payee any of the owner's policies allows.
   */
  allowedPayees: Address[];
  /** This policy's own pause, or (unscoped) whether any policy was last left paused. */
  paused: boolean;
  /** The owner-wide pause, which stops every policy whatever its own state. */
  fleetPaused: boolean;
  /**
   * Set when only recent history was read (the service was unavailable and a full chain walk
   * would take minutes). Everything folded from history, the allowlist above included, is then
   * only what changed since this block, and callers must say so rather than present it as whole.
   */
  partialFrom?: bigint | undefined;
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
export function projectAuditLog(logs: readonly EngineLog[], owner: Address, policyId?: bigint): AuditLog {
  // Filtered here rather than in an RPC topic filter, because every event type is fetched
  // in one pass. Every event carries the owner as a topic (ADR 0010).
  const mine = logs.filter(
    (log) => String(log.args.owner ?? "").toLowerCase() === owner.toLowerCase(),
  );

  const entries: Activity[] = [];

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
      policyId?: bigint;
    };

    const base = {
      key: spendKey(log.transactionHash, log.logIndex),
      blockNumber: log.blockNumber,
      timestamp: 0,
      txHash: log.transactionHash,
      // Zero on a refusal for an unbound key: no policy, so none to attribute it to.
      policyId: a.policyId === undefined || a.policyId === 0n ? undefined : a.policyId,
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
        entries.push({...base, kind: a.allowed ? "payee-allowed" : "payee-removed", payee: a.payee});
        break;

      case "PauseSet":
        entries.push({...base, kind: a.paused ? "paused" : "resumed"});
        break;

      // The fleet switch: every agent at once.
      case "OwnerPauseSet":
        entries.push({...base, kind: a.paused ? "fleet-paused" : "fleet-resumed"});
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

  // One fold for both paths (raw logs here, indexed rows in `auditFromActivity`), so they
  // cannot disagree about the allowlist or the pause.
  return auditFromActivity(entries, policyId);
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
    case "fleet-paused":
      return "You paused every agent";
    case "fleet-resumed":
      return "You resumed every agent";
  }
}

export function reasonText(reason: Reason): string {
  return explainToOwner(reason);
}

/**
 * Rebuild an audit log from activity rows that were already projected, such as the service's
 * index plus a fresh read of the unindexed tip.
 *
 * The allowlist and paused state are folded from the rows themselves, oldest first, so this
 * agrees with `projectAuditLog` over the same events. Rows are de-duplicated by key
 * (`tx_hash:log_index`), which is what makes merging an index with an overlapping chain read
 * safe.
 */
export function auditFromActivity(rows: readonly Activity[], policyId?: bigint): AuditLog {
  const byKey = new Map<string, Activity>();
  for (const row of rows) {
    if (policyId === undefined || belongsTo(row, policyId)) byKey.set(row.key, row);
  }

  const logIndex = (key: string) => Number(key.slice(key.lastIndexOf(":") + 1)) || 0;
  const oldestFirst = [...byKey.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber ? logIndex(a.key) - logIndex(b.key) : a.blockNumber < b.blockNumber ? -1 : 1,
  );

  // Keyed by policy as well as payee: unscoped, the same payee can be allowed on one policy
  // and removed on another, and one policy's removal must not hide the other's approval.
  const payees = new Map<string, Address>();
  const pausedBy = new Map<string, boolean>();
  let fleetPaused = false;
  for (const row of oldestFirst) {
    const scope = String(row.policyId ?? "");
    if (row.kind === "payee-allowed" && row.payee) payees.set(`${scope}:${row.payee.toLowerCase()}`, row.payee);
    if (row.kind === "payee-removed" && row.payee) payees.delete(`${scope}:${row.payee.toLowerCase()}`);
    if (row.kind === "paused") pausedBy.set(scope, true);
    if (row.kind === "resumed") pausedBy.set(scope, false);
    if (row.kind === "policy-revoked") pausedBy.delete(scope);
    if (row.kind === "fleet-paused") fleetPaused = true;
    if (row.kind === "fleet-resumed") fleetPaused = false;
  }

  const unique = new Map<string, Address>();
  for (const payee of payees.values()) unique.set(payee.toLowerCase(), payee);

  return {
    entries: oldestFirst.reverse(),
    allowedPayees: [...unique.values()],
    paused: [...pausedBy.values()].some(Boolean),
    fleetPaused,
  };
}
