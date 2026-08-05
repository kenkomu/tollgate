import {arcTestnet, policyEngineAbi} from "@tollgate/shared";
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
export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.ARC_RPC_URL ?? arcTestnet.rpcUrls.default.http[0]),
});

export const ENGINE = (process.env.POLICY_ENGINE_ADDRESS ?? "") as Address;
export const OWNER = (process.env.OWNER_ADDRESS ?? "") as Address;

export const abi = policyEngineAbi;

export function isConfigured(): boolean {
  return Boolean(ENGINE) && Boolean(OWNER);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function txUrl(hash: string): string {
  return `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${arcTestnet.blockExplorers.default.url}/address/${address}`;
}
