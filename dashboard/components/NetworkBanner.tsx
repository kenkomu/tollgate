import {activeChain} from "@tollgate/shared";

/**
 * Shown on mainnet only. Testnet is the default and needs no warning; mainnet moves real
 * USDC, so the page says so on every route. Amber, not red — red is reserved for refusals.
 */
export function NetworkBanner() {
  if (activeChain.testnet) return null;
  return (
    <div className="network-banner" role="status">
      <strong>Arc mainnet.</strong> Transactions signed here move real USDC. Approve only the
      budget you intend to let the agent spend.
    </div>
  );
}

export function NetworkPill() {
  const test = Boolean(activeChain.testnet);
  return (
    <p className={`network-pill${test ? "" : " live"}`}>
      <span className="network-dot" aria-hidden="true" />
      {test ? "Arc testnet · play money" : "Arc mainnet · real USDC"}
    </p>
  );
}
