import type {Address} from "viem";

/** Mirrors `PolicyEngine.Policy`. All amounts are 6-decimal USDC. */
export interface Policy {
  agent: Address;
  /** Whose wallet this policy spends from. */
  owner: Address;
  /** Unix seconds. 0 means never expires. */
  expiry: bigint;
  paused: boolean;
  exists: boolean;
  budgetCap: bigint;
  spent: bigint;
  perTxCap: bigint;
  bucketCapacity: bigint;
  refillPerSecond: bigint;
  /** Bucket level as of `lastRefill` — not as of now. Use `availableNow` for that. */
  available: bigint;
  lastRefill: bigint;
}

/** A `Spent` event, projected. Keyed for idempotent ingestion per §3.5. */
export interface SpendRecord {
  owner: Address;
  policyId: bigint;
  agent: Address;
  payee: Address;
  amount: bigint;
  spentTotal: bigint;
  availableAfter: bigint;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
}

/**
 * Idempotency key for event ingestion.
 *
 * §3.5 requires ingestion to be idempotent by `tx_hash + log_index`. A reorg or a
 * replayed webhook must not double-count a payment in the audit log.
 */
export function spendKey(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}

/** True once the policy's session key has expired. */
export function isExpired(policy: Pick<Policy, "expiry">, now = Date.now()): boolean {
  if (policy.expiry === 0n) return false;
  return BigInt(Math.floor(now / 1000)) > policy.expiry;
}

/**
 * Recompute the token bucket off-chain, matching `PolicyEngine._availableNow` exactly.
 *
 * This is the §2.3 "policy simulator": a fast local mirror so the dashboard and SDK can
 * show headroom without an RPC round trip. It is a projection, never an authority — when
 * this and the chain disagree, the chain is right and this is the bug.
 */
export function availableNow(policy: Policy, nowSeconds = Math.floor(Date.now() / 1000)): bigint {
  if (!policy.exists) return 0n;
  const elapsed = BigInt(nowSeconds) - policy.lastRefill;
  if (elapsed < 0n) return policy.available;
  const refilled = policy.available + elapsed * policy.refillPerSecond;
  return refilled > policy.bucketCapacity ? policy.bucketCapacity : refilled;
}

export function remainingBudget(policy: Policy): bigint {
  return policy.budgetCap > policy.spent ? policy.budgetCap - policy.spent : 0n;
}

/** Fraction of the lifetime budget consumed, 0–1, for progress meters. */
export function budgetUsedFraction(policy: Policy): number {
  if (policy.budgetCap === 0n) return 1;
  return Number((policy.spent * 10000n) / policy.budgetCap) / 10000;
}

/** A policy together with its id, which every owner write needs. */
export interface PolicyWithId extends Policy {
  id: bigint;
}

/** Display name for an agent until the owner gives it one: "Agent 3". */
export function agentLabel(id: bigint): string {
  return `Agent ${id}`;
}
