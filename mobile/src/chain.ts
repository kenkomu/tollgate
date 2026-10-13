import {createPublicClient, http, type Address} from "viem";
import {activeChain, availableNow, policyEngineAbi, type Policy} from "@tollgate/shared";
import Constants from "expo-constants";

/**
 * Policy state comes from the chain, not from our service.
 *
 * This is deliberate and it is the difference between an app you have to trust and one you can
 * check. The service indexes *history*, which is a convenience. The **current limits** — how
 * much budget is left, whether the agent is paused, what the caps are — are read straight from
 * `PolicyEngine` by this device.
 *
 * So if our backend is down, wrong, or hostile, this screen still shows the truth. And the
 * numbers here are the same numbers the contract will enforce a second from now, because they
 * came from the contract.
 */

const engine = (Constants.expoConfig?.extra?.engine as string | undefined) ?? "";
const owner = (Constants.expoConfig?.extra?.owner as string | undefined) ?? "";

export const ENGINE = engine as Address;
export const OWNER = owner as Address;

export const client = createPublicClient({
  chain: activeChain,
  transport: http(undefined, {timeout: 15_000, retryCount: 3}),
});

export function isConfigured(): boolean {
  return Boolean(ENGINE) && Boolean(OWNER);
}

export interface LivePolicy extends Policy {
  /** Rate-limit headroom right now, recomputed locally from the bucket. */
  headroom: bigint;
  /** When this was read, so the UI can say how old it is. */
  readAt: number;
}

export async function readPolicy(): Promise<LivePolicy> {
  const raw = (await client.readContract({
    address: ENGINE,
    abi: policyEngineAbi,
    functionName: "getPolicy",
    args: [OWNER],
  })) as unknown as Policy;

  return {...raw, headroom: availableNow(raw), readAt: Date.now()};
}

export function explorerTx(hash: string): string {
  return `${activeChain.blockExplorers.default.url}/tx/${hash}`;
}
