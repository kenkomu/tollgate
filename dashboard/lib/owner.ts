"use server";

import {arcFees, arcTestnet} from "@tollgate/shared";
import {revalidatePath} from "next/cache";
import {createWalletClient, http, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {ENGINE, abi, publicClient} from "./chain.ts";
import {removeRequest} from "./approvals.ts";

/**
 * Owner actions.
 *
 * MVP SHORTCUT, stated plainly: the owner's key is read from the server environment and
 * these actions are signed here. That is convenient for a testnet demo and it sits
 * awkwardly against the non-custodial thesis — a server holding the owner key is exactly
 * the arrangement Tollgate argues against.
 *
 * The intended replacement is a Circle Modular Wallet: the owner authenticates with a
 * passkey, the key never leaves their device, and these become client-side transactions.
 * `PolicyEngine` does not care which it is — the owner is just an address that granted an
 * allowance — so this is a swap, not a rewrite. See BACKLOG.md at the repo root.
 */

function ownerWallet() {
  const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("DEPLOYER_PRIVATE_KEY is not set — owner actions are unavailable.");
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: arcTestnet,
    transport: http(process.env.ARC_RPC_URL ?? arcTestnet.rpcUrls.default.http[0]),
  });
}

async function send(functionName: "setPaused" | "setPayee", args: readonly unknown[]): Promise<string> {
  const wallet = ownerWallet();

  // Floored to Arc's 20 Gwei minimum. An owner action left underpriced sits in the mempool
  // indefinitely, and the most important of these is the kill switch — the one write in
  // this system that must never be the thing that failed to mine.
  const fees = await arcFees(publicClient);

  const {request} = await publicClient.simulateContract({
    address: ENGINE,
    abi,
    functionName,
    args: args as never,
    account: wallet.account,
    ...fees,
  });
  const hash = await wallet.writeContract(request);

  // Bounded. Without a timeout this server action hangs for viem's 180s default, and the
  // owner is left staring at "Signing…" with no idea whether the agent is stopped.
  await publicClient.waitForTransactionReceipt({hash, timeout: 60_000});
  return hash;
}

/**
 * The kill switch.
 *
 * One transaction, owner straight to chain. No queue, no relayer, no dependency on this
 * dashboard staying up — if this server dies mid-click the owner can still call
 * `setPaused` from any wallet or block explorer, and §3.5 requires exactly that.
 */
export async function setPaused(paused: boolean): Promise<{ok: boolean; hash?: string; error?: string}> {
  try {
    const hash = await send("setPaused", [paused]);
    revalidatePath("/");
    return {ok: true, hash};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

/** Add a payee to the on-chain allowlist. The only way past a PAYEE_NOT_ALLOWED refusal. */
export async function approvePayee(payee: Address): Promise<{ok: boolean; hash?: string; error?: string}> {
  try {
    const hash = await send("setPayee", [payee, true]);
    await removeRequest(payee);
    revalidatePath("/");
    return {ok: true, hash};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

/** Remove a payee. Takes effect on the next attempted payment. */
export async function revokePayee(payee: Address): Promise<{ok: boolean; hash?: string; error?: string}> {
  try {
    const hash = await send("setPayee", [payee, false]);
    revalidatePath("/");
    return {ok: true, hash};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

/** Dismiss a request without allowlisting. The agent stays refused. */
export async function declineRequest(payee: Address): Promise<{ok: boolean}> {
  await removeRequest(payee);
  revalidatePath("/");
  return {ok: true};
}
