import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  ARC_TESTNET_CONTRACTS,
  GAS_BUFFER_PERCENT,
  MAX_LOG_BLOCK_RANGE,
  MIN_GAS_PRICE_WEI,
  SUGGESTED_PRIORITY_FEE_WEI,
  USDC_ADDRESS,
  arcFees,
  arcTestnet,
  explorerAddress,
  explorerTx,
  withGasBuffer,
} from "../src/chain.ts";

/** A stub node. `arcFees` only needs these two calls, so this is the whole surface. */
function node(baseFeePerGas: bigint | null, priority: bigint | Error = SUGGESTED_PRIORITY_FEE_WEI) {
  return {
    getBlock: async () => ({baseFeePerGas}),
    estimateMaxPriorityFeePerGas: async () => {
      if (priority instanceof Error) throw priority;
      return priority;
    },
  };
}

/**
 * Arc rejects transactions bid below a 20 Gwei base fee, and the docs say they "may remain
 * pending indefinitely or fail outright". A stuck owner write is the worst case in this
 * system, because the kill switch is an owner write.
 */
describe("arcFees respects Arc's gas floor", () => {
  it("lifts a base fee below the floor up to it", async () => {
    const fees = await arcFees(node(1_000_000_000n)); // 1 Gwei, far under the floor
    assert.equal(fees.maxFeePerGas, MIN_GAS_PRICE_WEI * 2n + SUGGESTED_PRIORITY_FEE_WEI);
  });

  it("uses the real base fee when it is above the floor", async () => {
    const base = MIN_GAS_PRICE_WEI * 3n;
    const fees = await arcFees(node(base));
    assert.equal(fees.maxFeePerGas, base * 2n + SUGGESTED_PRIORITY_FEE_WEI);
  });

  it("treats a missing base fee as the floor rather than as zero", async () => {
    // A node that omits baseFeePerGas must not be read as "gas is free".
    const fees = await arcFees(node(null));
    assert.equal(fees.maxFeePerGas, MIN_GAS_PRICE_WEI * 2n + SUGGESTED_PRIORITY_FEE_WEI);
  });

  it("never bids a tip below the suggested floor", async () => {
    const fees = await arcFees(node(MIN_GAS_PRICE_WEI, 1n));
    assert.equal(fees.maxPriorityFeePerGas, SUGGESTED_PRIORITY_FEE_WEI);
  });

  it("honours a tip above the floor", async () => {
    const generous = SUGGESTED_PRIORITY_FEE_WEI * 5n;
    const fees = await arcFees(node(MIN_GAS_PRICE_WEI, generous));
    assert.equal(fees.maxPriorityFeePerGas, generous);
  });

  it("falls back to the suggested tip when the node will not estimate one", async () => {
    // Losing the tip estimate must not lose the transaction.
    const fees = await arcFees(node(MIN_GAS_PRICE_WEI, new Error("method not supported")));
    assert.equal(fees.maxPriorityFeePerGas, SUGGESTED_PRIORITY_FEE_WEI);
    assert.ok(fees.maxFeePerGas >= MIN_GAS_PRICE_WEI);
  });

  it("always leaves the cap at or above the tip", async () => {
    for (const base of [0n, 1n, MIN_GAS_PRICE_WEI, MIN_GAS_PRICE_WEI * 10n]) {
      const fees = await arcFees(node(base));
      assert.ok(fees.maxFeePerGas >= fees.maxPriorityFeePerGas, `inverted at base=${base}`);
      assert.ok(fees.maxFeePerGas >= MIN_GAS_PRICE_WEI, `under the floor at base=${base}`);
    }
  });
});

/**
 * Arc's estimator returned 97,846 for a call that needed 96,931 — 0.9% of headroom, closed
 * by any warm/cold storage difference between estimating and executing. Documented in
 * docs/circle-feedback.md §6.
 */
describe("withGasBuffer", () => {
  it("adds the documented headroom", () => {
    assert.equal(GAS_BUFFER_PERCENT, 30n);
    assert.equal(withGasBuffer(100_000n), 130_000n);
  });

  it("covers the gap that actually failed on chain", () => {
    // The measured case: a 97,846 estimate against 96,931 of real consumption.
    assert.ok(withGasBuffer(97_846n) > 96_931n * 12n / 10n);
  });

  it("never returns less than the estimate", () => {
    for (const estimate of [0n, 1n, 21_000n, 5_000_000n]) {
      assert.ok(withGasBuffer(estimate) >= estimate);
    }
  });
});

describe("chain constants", () => {
  it("pins Arc testnet's identity", () => {
    // Verified against the live RPC: eth_chainId returns 0x4cef52.
    assert.equal(arcTestnet.id, 5042002);
    assert.equal(arcTestnet.testnet, true);
  });

  it("declares native USDC as 18 decimals, which is not the transfer interface", () => {
    // Both numbers are correct and they are not interchangeable. Native gas accounting is
    // 18; every policy amount is 6. See amounts.test.ts.
    assert.equal(arcTestnet.nativeCurrency.decimals, 18);
  });

  it("points USDC at the ERC-20 predeploy", () => {
    assert.equal(USDC_ADDRESS, "0x3600000000000000000000000000000000000000");
    assert.equal(ARC_TESTNET_CONTRACTS.usdc, USDC_ADDRESS);
  });

  it("keeps log queries inside the range Arc actually serves", () => {
    // The error message advertises 100,000; probing showed 50,000 refused and 20,000 served.
    assert.ok(MAX_LOG_BLOCK_RANGE <= 20_000n);
  });

  it("builds explorer links against the configured explorer", () => {
    assert.equal(explorerTx("0xabc"), "https://testnet.arcscan.app/tx/0xabc");
    assert.equal(explorerAddress("0xdef"), "https://testnet.arcscan.app/address/0xdef");
  });
});

describe("arcChainFor", () => {
  it("defaults to testnet and selects mainnet by id", async () => {
    const {arcChainFor, arcMainnet} = await import("../src/chain.ts");
    assert.equal(arcChainFor(undefined).id, 5042002);
    assert.equal(arcChainFor("5042").id, arcMainnet.id);
    assert.throws(() => arcChainFor("1"), /not an Arc network/);
  });
});
