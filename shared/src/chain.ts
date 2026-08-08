import {defineChain} from "viem";

/**
 * Arc testnet.
 *
 * Arc is testnet-only — mainnet is not live. Verified against the live RPC:
 * eth_chainId returns 0x4cef52 (5042002) and the node reports reth/v1.11.3.
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USD Coin",
    symbol: "USDC",
    // Arc's NATIVE USDC uses 18 decimals for gas accounting. The ERC-20
    // interface over the same balance uses 6. See USDC_DECIMALS below.
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.io"],
      webSocket: ["wss://rpc.testnet.arc.io"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
      apiUrl: "https://testnet.arcscan.app/api",
    },
  },
  testnet: true,
});

/**
 * USDC's ERC-20 interface on Arc — a predeploy that forwards balance queries to the
 * account's native balance. Same asset, same balance, two interfaces. This is the
 * one that exposes `approve` / `transferFrom`, which is what makes allowance-based
 * enforcement possible at all.
 */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

/**
 * Six. Not eighteen.
 *
 * The single most dangerous number in this codebase. Arc's native USDC is 18-decimal
 * for gas accounting; the ERC-20 interface is 6-decimal for transfers. Mixing them is
 * a 10^12 error in software that moves money.
 *
 * House rule: every amount that crosses a Tollgate boundary — contract, API, UI — is
 * 6-decimal ERC-20 units. Nothing here ever reads a native balance.
 */
export const USDC_DECIMALS = 6 as const;

/**
 * Arc testnet contract addresses, transcribed from
 * https://docs.arc.io/arc/references/contract-addresses
 *
 * Kept here so nothing else in the repo hard-codes an address. Mainnet addresses do
 * not exist yet — Arc is testnet-only.
 */
export const ARC_TESTNET_CONTRACTS = {
  // Stablecoins (all 6 decimals on their ERC-20 interfaces)
  usdc: USDC_ADDRESS,
  eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  usyc: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",

  // Circle Gateway — where nanopayment balances live. Note that per-call x402
  // payments settle OFF-chain against this balance, so PolicyEngine cannot see
  // them; our enforcement point is the top-up. See docs/decisions/0005.
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",

  // CCTP v2 — the multi-chain path in the plan's Phase 5.
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  tokenMinterV2: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
  messageV2: "0xbaC0179bB358A8936169a63408C8481D582390C4",

  // StableFX
  fxEscrow: "0xd68256f4D69C6BbEcB873D8588AE0Dc6B8E22E10",

  // Transaction extensions
  memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
  multicall3From: "0x522fAf9A91c41c443c66765030741e4AaCe147D0",

  // Standard deployments
  create2: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;

/** Circle Gateway's domain id for Arc testnet. Gateway reuses CCTP domain ids. */
export const ARC_GATEWAY_DOMAIN = 26 as const;

/**
 * Gas floor on Arc testnet.
 *
 * The docs are explicit: the minimum base fee is 20 Gwei and transactions submitted
 * below that floor "may remain pending indefinitely or fail outright". Query
 * `eth_gasPrice` before sending, and never fall back to a hard-coded value under this.
 */
export const MIN_GAS_PRICE_WEI = 20_000_000_000n; // 20 Gwei
export const SUGGESTED_PRIORITY_FEE_WEI = 1_000_000_000n; // 1 Gwei tip

/**
 * Largest `eth_getLogs` span Arc's RPC will actually serve.
 *
 * The error message claims 100,000 — "query exceeds max block range 100000" — but a
 * 100,000-block window is then refused with "requested range too large". Probing the
 * endpoint directly: 50,000 fails, 20,000 succeeds. So the advertised limit is not the
 * enforced one, and 20,000 is what we use.
 *
 * At roughly half-second blocks this is only a few hours of history per request, so any
 * log read over a useful period must be chunked. Reading from genesis is not slow here,
 * it is refused outright.
 */
export const MAX_LOG_BLOCK_RANGE = 20_000n;

/**
 * How far back a live chain read will reach before we stop chunking.
 *
 * ~400,000 blocks is a couple of days on Arc, which is about 20 requests. Beyond that,
 * reading history straight from the RPC on every page load stops being reasonable and
 * the answer is the indexer in plan §2.3 — a cache in front of the chain, never an
 * authority over it. Until that exists, the dashboard shows recent history and says so.
 */
export const MAX_HISTORY_BLOCKS = 400_000n;

/**
 * Block in which the current PolicyEngine was deployed.
 *
 * Every log query starts here rather than at genesis. Override with
 * POLICY_ENGINE_DEPLOY_BLOCK when pointing at a different deployment.
 */
export const POLICY_ENGINE_DEPLOY_BLOCK = 55_621_174n;

/**
 * Fees that clear Arc's floor.
 *
 * Arc enforces a 20 Gwei minimum base fee, and the documentation is explicit that a
 * transaction submitted below it "may remain pending indefinitely or fail outright" —
 * which is the single most likely cause of a stuck payment on this chain. So the floor is
 * applied rather than trusted to the estimator: whatever the node suggests, never bid
 * under it. The doubling is headroom for a base-fee rise between estimating and inclusion.
 *
 * Lives here rather than in either caller because both the agent's `spend` and the
 * dashboard's owner actions need it, and the kill switch is the last write in this system
 * that should ever sit unmined.
 */
export async function arcFees(client: {
  getBlock: (args: {blockTag: "latest"}) => Promise<{baseFeePerGas?: bigint | null}>;
  estimateMaxPriorityFeePerGas: () => Promise<bigint>;
}): Promise<{maxFeePerGas: bigint; maxPriorityFeePerGas: bigint}> {
  const [block, suggested] = await Promise.all([
    client.getBlock({blockTag: "latest"}),
    client.estimateMaxPriorityFeePerGas().catch(() => SUGGESTED_PRIORITY_FEE_WEI),
  ]);

  const base = block.baseFeePerGas ?? MIN_GAS_PRICE_WEI;
  const floored = base > MIN_GAS_PRICE_WEI ? base : MIN_GAS_PRICE_WEI;
  const priority = suggested > SUGGESTED_PRIORITY_FEE_WEI ? suggested : SUGGESTED_PRIORITY_FEE_WEI;

  return {maxFeePerGas: floored * 2n + priority, maxPriorityFeePerGas: priority};
}

/**
 * Headroom to add to Arc's gas estimate before submitting.
 *
 * `eth_estimateGas` on Arc comes back with under 1% of margin on a USDC transfer, and it
 * is not enough. Measured on a live payment: the estimate was 97,846 and execution needed
 * 96,931 — a 0.9% gap that a single warm/cold storage difference between estimating and
 * executing closes entirely. The failure is nasty because it does not look like one:
 * `Spent` has already been emitted when the transfer runs out of gas, so the whole
 * transaction reverts, the event is discarded, and the payment simply vanishes with a bare
 * "reverted" and no reason.
 *
 * The cost of over-buffering is nothing — unused gas is refunded. The cost of
 * under-buffering is a payment that fails for reasons no one can see.
 */
export const GAS_BUFFER_PERCENT = 30n;

export function withGasBuffer(estimate: bigint): bigint {
  return (estimate * (100n + GAS_BUFFER_PERCENT)) / 100n;
}

/**
 * How often to poll Arc for new state.
 *
 * viem defaults to 4,000ms, which is tuned for Ethereum's ~12s blocks. Arc has sub-second
 * finality, so the default spends most of a receipt's wait doing nothing — a payment that
 * settled in 400ms is not noticed for up to four seconds, and every agent action inherits
 * that latency. 500ms tracks the block time without hammering the endpoint, which matters
 * because Arc rate-limits bursts with -32005.
 */
export const ARC_POLLING_INTERVAL_MS = 500;

export const FAUCET_URL = "https://faucet.circle.com";

export function explorerTx(hash: string): string {
  return `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${arcTestnet.blockExplorers.default.url}/address/${address}`;
}
