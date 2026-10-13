import assert from "node:assert/strict";
import {describe, it} from "node:test";
import type {Address} from "viem";
import {usdc} from "../src/amounts.ts";
import {
  availableNow,
  budgetUsedFraction,
  isExpired,
  remainingBudget,
  spendKey,
  type Policy,
} from "../src/policy.ts";

const AGENT = "0x1111111111111111111111111111111111111111" as Address;

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    agent: AGENT,
    owner: "0x2222222222222222222222222222222222222222",
    expiry: 0n,
    paused: false,
    exists: true,
    budgetCap: usdc("100"),
    spent: 0n,
    perTxCap: usdc("10"),
    bucketCapacity: usdc("4"),
    refillPerSecond: usdc("0.01"),
    available: usdc("4"),
    lastRefill: 1_000n,
    ...overrides,
  };
}

/**
 * `availableNow` is the off-chain mirror of `PolicyEngine._availableNow`.
 *
 * The dashboard shows headroom from it and the agent decides how long to wait from it, both
 * without an RPC round trip. When it and the contract disagree the contract is right, which
 * means every disagreement shows up as the UI promising room that the chain then refuses —
 * the enforcement layer looking broken when it is the mirror that is.
 */
describe("availableNow mirrors the contract's token bucket", () => {
  it("refills linearly with elapsed time", () => {
    const p = policy({available: 0n, refillPerSecond: usdc("1"), lastRefill: 1_000n});
    assert.equal(availableNow(p, 1_000), 0n);
    assert.equal(availableNow(p, 1_001), usdc("1"));
    assert.equal(availableNow(p, 1_003), usdc("3"));
  });

  it("clamps at capacity and never exceeds it", () => {
    const p = policy({available: 0n, refillPerSecond: usdc("1"), bucketCapacity: usdc("4")});
    assert.equal(availableNow(p, 1_010), usdc("4"));
    assert.equal(availableNow(p, 9_999_999), usdc("4"));
  });

  it("returns nothing for a policy that does not exist", () => {
    // A zeroed struct reads as a full bucket if you forget this check.
    assert.equal(availableNow(policy({exists: false, available: usdc("4")})), 0n);
  });

  it("does not refill backwards when the local clock is behind the chain", () => {
    /**
     * Solidity computes `block.timestamp - lastRefill` in uint256 and cannot go negative,
     * because it writes `lastRefill` from its own clock. Off-chain we are reading a value the
     * chain wrote, against a local clock that may lag it. Treating that as negative elapsed
     * time would subtract from the bucket and under-report headroom.
     */
    const p = policy({available: usdc("2"), lastRefill: 5_000n});
    assert.equal(availableNow(p, 4_000), usdc("2"));
  });

  it("holds still when the refill rate is zero", () => {
    const p = policy({available: usdc("1"), refillPerSecond: 0n});
    assert.equal(availableNow(p, 999_999), usdc("1"));
  });
});

/**
 * A differential test against an independently written bucket.
 *
 * The reference below is deliberately not a copy of the implementation — it clamps by
 * comparison against a separately computed ceiling rather than by conditional expression,
 * so a transcription slip in one is unlikely to appear in the other. Fixed seed, so a
 * failure is reproducible rather than a flake.
 */
describe("differential: independent token-bucket reference", () => {
  function reference(available: bigint, rate: bigint, capacity: bigint, elapsed: bigint): bigint {
    if (elapsed < 0n) elapsed = 0n;
    const gained = rate * elapsed;
    const total = available + gained;
    const overflow = total > capacity ? total - capacity : 0n;
    return total - overflow;
  }

  it("agrees across 20,000 pseudo-random states", () => {
    // xorshift32 — deterministic, seeded, no dependency.
    let seed = 0x9e3779b9;
    const next = (bound: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed % bound;
    };

    for (let i = 0; i < 20_000; i++) {
      const capacity = BigInt(next(50_000_000) + 1);
      const available = BigInt(next(Number(capacity) + 1));
      const rate = BigInt(next(10_000));
      const elapsed = BigInt(next(200_000));
      const lastRefill = 1_000_000n;

      const p = policy({
        exists: true,
        available,
        refillPerSecond: rate,
        bucketCapacity: capacity,
        lastRefill,
      });

      const mine = availableNow(p, Number(lastRefill + elapsed));
      const theirs = reference(available, rate, capacity, elapsed);

      assert.equal(
        mine,
        theirs,
        `available=${available} rate=${rate} capacity=${capacity} elapsed=${elapsed}`,
      );
      assert.ok(mine <= capacity, "bucket exceeded its capacity");
      assert.ok(mine >= 0n, "bucket went negative");
    }
  });
});

describe("remainingBudget", () => {
  it("is the gap between cap and spend", () => {
    assert.equal(remainingBudget(policy({budgetCap: usdc("100"), spent: usdc("40")})), usdc("60"));
  });

  it("floors at zero rather than going negative", () => {
    // The contract cannot let spent exceed cap, but a stale read against a lowered cap can
    // show it. A negative "remaining" would render as a nonsense figure in the UI.
    assert.equal(remainingBudget(policy({budgetCap: usdc("10"), spent: usdc("40")})), 0n);
  });
});

describe("budgetUsedFraction", () => {
  it("reports the fraction consumed", () => {
    assert.equal(budgetUsedFraction(policy({budgetCap: usdc("100"), spent: usdc("25")})), 0.25);
    assert.equal(budgetUsedFraction(policy({spent: 0n})), 0);
  });

  it("treats a zero cap as fully used, not as a division by zero", () => {
    // A meter reading NaN is worse than a meter reading full, and a zero cap genuinely
    // means nothing further may be spent.
    assert.equal(budgetUsedFraction(policy({budgetCap: 0n, spent: 0n})), 1);
  });
});

describe("isExpired", () => {
  const NOW_MS = 2_000_000_000_000;

  it("treats zero as never expiring", () => {
    assert.equal(isExpired({expiry: 0n}, NOW_MS), false);
  });

  it("is false at the expiry second and true after it", () => {
    // The contract compares with strict `>`, so the expiry second itself is still valid.
    const expiry = BigInt(Math.floor(NOW_MS / 1000));
    assert.equal(isExpired({expiry}, NOW_MS), false);
    assert.equal(isExpired({expiry}, NOW_MS + 1000), true);
  });
});

describe("spendKey", () => {
  it("is idempotent across hash casing", () => {
    // §3.5 requires ingestion keyed by tx_hash + log_index. A replayed webhook that differs
    // only in hex casing must not be counted as a second payment.
    assert.equal(spendKey("0xABC", 3), spendKey("0xabc", 3));
  });

  it("separates two events in the same transaction", () => {
    assert.notEqual(spendKey("0xabc", 0), spendKey("0xabc", 1));
  });
});
