import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {parseEther} from "viem";
import {
  formatUsdc,
  formatUsdcApprox,
  fromUsdc,
  ratePerDay,
  refillRateFor,
  secondsUntilAvailable,
  usdc,
} from "../src/amounts.ts";
import {USDC_DECIMALS} from "../src/chain.ts";

/**
 * The decimal tests exist because of one specific bug.
 *
 * Arc's native USDC is 18-decimal for gas; the ERC-20 interface is 6-decimal for transfers.
 * Reaching for `parseEther` out of habit produces a value 10^12 too large, and nothing in
 * the type system objects — both are `bigint`. These assertions are the guardrail.
 */

describe("USDC is six decimals, everywhere", () => {
  it("parses to 6-decimal base units", () => {
    assert.equal(USDC_DECIMALS, 6);
    assert.equal(usdc("1"), 1_000_000n);
    assert.equal(usdc("12.50"), 12_500_000n);
    assert.equal(usdc(0.000001), 1n);
  });

  it("is a million times smaller than the 18-decimal reading of the same number", () => {
    // The exact mistake this file guards. If someone swaps in parseEther, this fails loudly.
    assert.equal(parseEther("1") / usdc("1"), 1_000_000_000_000n);
  });

  it("round-trips through fromUsdc", () => {
    for (const amount of ["0", "0.000001", "1", "12.5", "999999.999999"]) {
      assert.equal(fromUsdc(usdc(amount)), String(Number(amount)));
    }
  });
});

describe("formatting a record versus formatting a gauge", () => {
  it("keeps all six decimals for a record", () => {
    // A payment or a cap is a fact. Rounding a fact is lying about what moved.
    assert.equal(formatUsdc(2_654_429n), "$2.654429");
    assert.equal(formatUsdc(usdc("12.50")), "$12.50");
    assert.equal(formatUsdc(0n), "$0.00");
  });

  it("rounds a gauge down to two decimals", () => {
    assert.equal(formatUsdcApprox(2_654_429n), "$2.65");
    assert.equal(formatUsdcApprox(0n), "$0.00");
  });

  it("never rounds a gauge up", () => {
    /**
     * Load-bearing. This renders rate-limit headroom. Rounding 2.659999 up to "$2.66" tells
     * the owner they have room the contract will refuse to grant, which reads as the
     * enforcement layer being wrong when it is the readout that is.
     */
    assert.equal(formatUsdcApprox(2_659_999n), "$2.65");
    assert.equal(formatUsdcApprox(999_999n), "$0.99");
    assert.equal(formatUsdcApprox(1n), "$0.00");
  });
});

describe("refill rates", () => {
  it("converts a human rate to per-second", () => {
    assert.equal(refillRateFor("86400", "day"), usdc("1"));
    assert.equal(refillRateFor("3600", "hour"), usdc("1"));
    assert.equal(refillRateFor("604800", "week"), usdc("1"));
  });

  it("truncates downward, never upward", () => {
    // Integer division loses a fraction. Losing it in the owner's favour is the only safe
    // direction: policy must never refill faster than what was asked for.
    const perSecond = refillRateFor("100", "day");
    assert.ok(perSecond * 86_400n <= usdc("100"));
    assert.ok(usdc("100") - perSecond * 86_400n < 86_400n);
  });

  it("renders a stored rate back for display", () => {
    assert.equal(ratePerDay(refillRateFor("86400", "day")), "86400");
  });

  it("floors a rate too small to represent to zero rather than rounding it up", () => {
    // Under one base unit per second is not representable. Zero means "never refills",
    // which is honest; rounding to 1 would silently grant 86,400x the requested rate.
    assert.equal(refillRateFor("0.000001", "day"), 0n);
  });
});

describe("secondsUntilAvailable", () => {
  const capacity = usdc("10");
  const rate = usdc("1"); // 1 USDC per second

  it("is zero when the bucket already covers it", () => {
    assert.equal(secondsUntilAvailable(usdc("5"), usdc("5"), rate, capacity), 0);
    assert.equal(secondsUntilAvailable(usdc("5"), usdc("1"), rate, capacity), 0);
  });

  it("is null when the target can never be reached", () => {
    // Above capacity the bucket will never hold it, however long you wait.
    assert.equal(secondsUntilAvailable(0n, usdc("11"), rate, capacity), null);
    // A zero refill rate is a bucket that never fills.
    assert.equal(secondsUntilAvailable(0n, usdc("5"), 0n, capacity), null);
  });

  it("rounds the wait up", () => {
    /**
     * Rounding down returns a moment at which the bucket is still one base unit short, so
     * the agent wakes, retries, and is refused again. Over-waiting by a second costs
     * nothing; under-waiting costs a wasted transaction and a confusing audit entry.
     */
    const wait = secondsUntilAvailable(0n, usdc("5") + 1n, rate, capacity);
    assert.equal(wait, 6);
  });

  it("computes an exact wait exactly", () => {
    assert.equal(secondsUntilAvailable(usdc("2"), usdc("5"), rate, capacity), 3);
  });

  it("allows a target exactly at capacity", () => {
    assert.equal(secondsUntilAvailable(0n, capacity, rate, capacity), 10);
  });
});
