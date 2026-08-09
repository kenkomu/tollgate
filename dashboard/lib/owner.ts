"use client";

import {arcFees, arcTestnet, USDC_ADDRESS} from "@tollgate/shared";
import {erc20Abi, type Address} from "viem";
import {ENGINE, abi, publicClient} from "./chain.ts";
import {clearRequest} from "./approval-actions.ts";
import {NoWalletError, OwnerMismatchError, ownerWallet} from "./wallet.ts";

/**
 * Owner actions, signed by the owner.
 *
 * These used to run on the server against `DEPLOYER_PRIVATE_KEY`. They now run in the
 * owner's browser against their own wallet, which means the server no longer holds anything
 * that can move money or change a policy. Delete this deployment and the owner still has
 * every one of these actions available from any wallet or block explorer — which is what
 * §3.5 requires of the kill switch, and is now true of all of them.
 *
 * The function signatures are unchanged from the server-action version, so the components
 * calling them did not have to care where the signature comes from.
 */

export type WriteResult = {ok: boolean; hash?: string; error?: string};

type OwnerWrite =
  | "setPaused"
  | "setPayee"
  | "setCaps"
  | "setVelocity"
  | "setExpiry"
  | "setAgent"
  | "createPolicy"
  | "revokePolicy";

async function send(functionName: OwnerWrite, args: readonly unknown[]): Promise<string> {
  const {client, account} = await ownerWallet();

  // Floored to Arc's 20 Gwei minimum. An owner action left underpriced sits in the mempool
  // indefinitely, and the most important of these is the kill switch — the one write in
  // this system that must never be the thing that failed to mine.
  const fees = await arcFees(publicClient);

  // Simulated before signing so the wallet prompt is only ever raised for a call that will
  // actually succeed. Asking someone to approve a transaction that is going to revert
  // teaches them to approve without reading.
  const {request} = await publicClient.simulateContract({
    address: ENGINE,
    abi,
    functionName,
    args: args as never,
    account,
    ...fees,
  });

  const hash = await client.writeContract(request);

  // Bounded. Without a timeout this hangs for viem's 180s default and the owner is left
  // staring at "Signing…" with no idea whether the agent is stopped.
  await publicClient.waitForTransactionReceipt({hash, timeout: 60_000});
  return hash;
}

/**
 * Every action below runs through this.
 *
 * Failures are returned rather than thrown, because the interesting ones are not bugs —
 * they are the contract refusing an edit, or the owner declining to sign, and both need to
 * be read rather than logged.
 */
async function attempt(work: () => Promise<string>): Promise<WriteResult> {
  try {
    return {ok: true, hash: await work()};
  } catch (error) {
    return {ok: false, error: humanise(error)};
  }
}

/** Contract and wallet errors are precise and unreadable. Keep the precision, drop the encoding. */
function humanise(error: unknown): string {
  if (error instanceof NoWalletError || error instanceof OwnerMismatchError) return error.message;

  const code = (error as {code?: number})?.code;
  // 4001 is the EIP-1193 "user rejected request". Not a failure worth alarming anyone about.
  if (code === 4001) return "You declined the signature. Nothing was changed.";

  const raw = error instanceof Error ? error.message : String(error);

  if (raw.includes("BudgetBelowSpent")) {
    return "That budget is below what the agent has already spent. Lowering it further would break the guarantee that spending never exceeds the cap — set it at or above the amount already gone.";
  }
  if (raw.includes("InvalidPayee")) {
    return "That address cannot be a payee. The policy contract can never send what it receives, so paying it would destroy the funds.";
  }
  if (raw.includes("AgentAlreadyBound")) {
    return "That key already belongs to another owner's policy. One agent key, one policy.";
  }
  if (raw.includes("ZeroAddress")) return "That address is empty.";
  if (raw.includes("PolicyExists")) return "This owner already has a policy. Edit it instead of creating another.";
  if (raw.includes("NoPolicy")) return "No policy exists for this owner yet.";
  if (raw.includes("insufficient funds")) {
    return "Not enough USDC in your wallet to cover gas for this transaction. Top up at faucet.circle.com.";
  }
  // Viem wraps the useful line in a lot of context; the first is almost always it.
  return raw.split("\n")[0] ?? raw;
}

/**
 * The kill switch.
 *
 * One transaction, owner straight to chain. No queue, no relayer, and now no server key
 * either — if this dashboard dies mid-click the owner can still call `setPaused` from any
 * wallet or block explorer.
 */
export async function setPaused(paused: boolean): Promise<WriteResult> {
  return attempt(() => send("setPaused", [paused]));
}

/** Add a payee to the on-chain allowlist. The only way past a PAYEE_NOT_ALLOWED refusal. */
export async function approvePayee(payee: Address): Promise<WriteResult> {
  const result = await attempt(() => send("setPayee", [payee, true]));
  // Only clear the request once the allowlisting is actually on chain. Clearing it first
  // would lose the ask if the owner declined the signature.
  if (result.ok) await clearRequest(payee);
  return result;
}

/** Remove a payee. Takes effect on the next attempted payment. */
export async function revokePayee(payee: Address): Promise<WriteResult> {
  return attempt(() => send("setPayee", [payee, false]));
}

/** Dismiss a request without allowlisting. The agent stays refused. */
export async function declineRequest(payee: Address): Promise<{ok: boolean}> {
  await clearRequest(payee);
  return {ok: true};
}

/*//////////////////////////////////////////////////////////////
                            POLICY EDITING
//////////////////////////////////////////////////////////////*/

/** Lifetime budget and the ceiling on any single payment. */
export async function setCaps(budgetCap: bigint, perTxCap: bigint): Promise<WriteResult> {
  return attempt(() => send("setCaps", [budgetCap, perTxCap]));
}

/**
 * Burst size and refill rate.
 *
 * The contract settles the bucket at the old rate before the new one applies, so widening
 * the limit never retroactively grants headroom the agent had not earned.
 */
export async function setVelocity(bucketCapacity: bigint, refillPerSecond: bigint): Promise<WriteResult> {
  return attempt(() => send("setVelocity", [bucketCapacity, refillPerSecond]));
}

/** Unix seconds, or 0 for never. */
export async function setExpiry(expiry: bigint): Promise<WriteResult> {
  return attempt(() => send("setExpiry", [expiry]));
}

/**
 * Rotate the agent key.
 *
 * The response to a suspected compromise, and the reason it is worth having in the UI: an
 * owner who thinks their agent's key has leaked should be one field away from making that
 * key worthless, not reading a Foundry guide. The old key is unbound in the same
 * transaction that binds the new one.
 */
export async function setAgent(newAgent: Address): Promise<WriteResult> {
  return attempt(() => send("setAgent", [newAgent]));
}

/** Allowlist an address directly, rather than waiting for the agent to ask. */
export async function addPayee(payee: Address): Promise<WriteResult> {
  return attempt(() => send("setPayee", [payee, true]));
}

/**
 * Tear the policy down.
 *
 * Deliberately does NOT touch the allowance — this contract has no business calling
 * `approve` on the owner's behalf, and the owner revoking it themselves is the whole
 * non-custodial exit path. The UI says so next to the button.
 */
export async function revokePolicy(): Promise<WriteResult> {
  return attempt(() => send("revokePolicy", []));
}

/**
 * Create the policy and fund it.
 *
 * Two signatures, and the order matters: approve first, then create. A policy with no
 * allowance behind it looks completely healthy on this dashboard and refuses every payment
 * with INSUFFICIENT_ALLOWANCE, which is a confusing first experience. Doing both here is
 * what removes the `forge script` step from onboarding.
 */
export async function createPolicy(params: {
  agent: Address;
  budgetCap: bigint;
  perTxCap: bigint;
  bucketCapacity: bigint;
  refillPerSecond: bigint;
  expiry: bigint;
}): Promise<WriteResult> {
  return attempt(async () => {
    const {client, account} = await ownerWallet();
    const fees = await arcFees(publicClient);

    // Exactly the budget, never max. If this contract is ever wrong, the blast radius is
    // the outstanding allowance rather than the owner's whole balance — ADR 0001.
    const approval = await client.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [ENGINE, params.budgetCap],
      chain: arcTestnet,
      account,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({hash: approval, timeout: 60_000});

    return send("createPolicy", [
      params.agent,
      params.budgetCap,
      params.perTxCap,
      params.bucketCapacity,
      params.refillPerSecond,
      params.expiry,
    ]);
  });
}

/** Top up (or cut) the allowance behind an existing policy. */
export async function setAllowance(amount: bigint): Promise<WriteResult> {
  return attempt(async () => {
    const {client, account} = await ownerWallet();
    const fees = await arcFees(publicClient);
    const hash = await client.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [ENGINE, amount],
      chain: arcTestnet,
      account,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({hash, timeout: 60_000});
    return hash;
  });
}
