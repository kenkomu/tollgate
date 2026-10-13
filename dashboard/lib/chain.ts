import {ARC_POLLING_INTERVAL_MS, activeChain, policyEngineAbi} from "@tollgate/shared";
import {createPublicClient, http, type Address} from "viem";

/**
 * Read access to Arc.
 *
 * There is no database here, and that is deliberate. Plan §2.4 makes the chain the source
 * of truth and every off-chain store a disposable projection; for the volumes this handles
 * today, the honest implementation of "disposable projection" is not to keep one. The
 * audit log below is rebuilt from contract logs on every request.
 *
 * Postgres arrives in Phase 2 when the read volume needs it — as a cache in front of this,
 * never as the authority.
 */
/**
 * Reads, with the public endpoint's behaviour accounted for.
 *
 * Arc's public RPC rate-limits bursts with `-32005` and, under load, simply takes a long
 * time. viem's defaults — a 10s timeout and three retries at 150ms — are tuned for a
 * dedicated endpoint and produce a hard failure here: loading three pages at once while the
 * settled-log cache is cold was enough to time out `getPolicy` and turn the overview into a
 * 500. A dashboard whose job is to tell you whether your agent is bounded must not be the
 * component that falls over when the chain is slow.
 *
 * Longer timeout, more retries, wider backoff. Arc settles in under a second, so a request
 * that has taken 20 seconds is queued behind a rate limit rather than mid-flight.
 */
export const publicClient = createPublicClient({
  chain: activeChain,
  transport: http(process.env.ARC_RPC_URL ?? activeChain.rpcUrls.default.http[0], {
    timeout: 20_000,
    // Exponential from 500ms: 0.5, 1, 2, 4, 8s. Long enough to outlast a burst limit; the
    // policy read is the one this page cannot do without.
    retryCount: 5,
    retryDelay: 500,
  }),
  pollingInterval: ARC_POLLING_INTERVAL_MS,
});

/**
 * Read on both sides of the wire.
 *
 * On the server the plain names are present. In the browser only `NEXT_PUBLIC_*` survives
 * bundling, and `next.config.ts` maps them across. Both are public addresses, not secrets —
 * the secret that used to live in this process is gone entirely, see `lib/owner.ts`.
 */
export const ENGINE = (process.env.POLICY_ENGINE_ADDRESS ||
  process.env.NEXT_PUBLIC_POLICY_ENGINE_ADDRESS ||
  "") as Address;

export const OWNER = (process.env.OWNER_ADDRESS ||
  process.env.NEXT_PUBLIC_OWNER_ADDRESS ||
  "") as Address;

export const abi = policyEngineAbi;

export function isConfigured(): boolean {
  return Boolean(ENGINE) && Boolean(OWNER);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function txUrl(hash: string): string {
  return `${activeChain.blockExplorers.default.url}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${activeChain.blockExplorers.default.url}/address/${address}`;
}
