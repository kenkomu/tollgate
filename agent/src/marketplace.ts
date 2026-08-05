import {usdc} from "@tollgate/shared";
import type {Address} from "viem";

/**
 * A small catalogue of paid services the agent can buy.
 *
 * This stands in for Circle's Agent Marketplace, which the Agent Stack starter kits reach
 * through the Circle CLI — but that kit "operates on Base mainnet only", so it cannot be
 * pointed at Arc and would move real money. The shape here mirrors what discovery returns:
 * a service, a price, and an address to pay.
 *
 * The important property for the demo is that `marketDataPro` is NOT on the owner's
 * allowlist. The agent will find it, want it, and be refused — which is the moment the
 * whole product is about.
 */

export interface Service {
  id: string;
  name: string;
  description: string;
  /** 6-decimal USDC */
  price: bigint;
  payee: Address;
  /** Whether the owner has allowlisted this payee. Discovered at runtime, not assumed. */
  knownToOwner: boolean;
}

const APPROVED_PAYEE = (process.env.PAYEE_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;

/** An address the owner has never seen. Discovery finds it; policy refuses it. */
const UNKNOWN_PAYEE = "0x0000000000000000000000000000000000c0ffee" as Address;

export const SERVICES: Service[] = [
  {
    id: "market-data-basic",
    name: "Market Data (basic)",
    description: "Delayed price feed for major pairs. Approved supplier.",
    price: usdc("1.50"),
    payee: APPROVED_PAYEE,
    knownToOwner: true,
  },
  {
    id: "sentiment-feed",
    name: "Sentiment Feed",
    description: "Rolling social sentiment index. Approved supplier.",
    price: usdc("2.00"),
    payee: APPROVED_PAYEE,
    knownToOwner: true,
  },
  {
    id: "market-data-pro",
    name: "Market Data Pro",
    description: "Real-time order book depth. New supplier, not yet approved by the owner.",
    price: usdc("1.75"),
    payee: UNKNOWN_PAYEE,
    knownToOwner: false,
  },
  {
    id: "bulk-compute",
    name: "Bulk Backtest Compute",
    description: "One hour of backtesting compute. Approved supplier, priced above the per-payment cap.",
    price: usdc("8.00"),
    payee: APPROVED_PAYEE,
    knownToOwner: true,
  },
];

export function findService(id: string): Service | undefined {
  return SERVICES.find((s) => s.id === id);
}
