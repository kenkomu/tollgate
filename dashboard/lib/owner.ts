"use server";

import {arcFees, arcTestnet, USDC_ADDRESS} from "@tollgate/shared";
import {revalidatePath} from "next/cache";
import {createWalletClient, erc20Abi, http, type Address, type Hex} from "viem";
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

/*//////////////////////////////////////////////////////////////
                            POLICY EDITING
//////////////////////////////////////////////////////////////*/

export type WriteResult = {ok: boolean; hash?: string; error?: string};

/**
 * Every editor below runs through this.
 *
 * Failures are returned rather than thrown, because the interesting ones are not bugs —
 * they are the contract refusing an edit, and the owner needs to read that. Lowering a
 * budget below what has already been spent is the common case, and `BudgetBelowSpent`
 * carrying two numbers is more useful to them than a stack trace.
 */
async function attempt(work: () => Promise<string>): Promise<WriteResult> {
  try {
    const hash = await work();
    revalidatePath("/");
    revalidatePath("/policy");
    revalidatePath("/payees");
    return {ok: true, hash};
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return {ok: false, error: humanise(raw)};
  }
}

/** Contract errors are precise and unreadable. Keep the precision, drop the encoding. */
function humanise(raw: string): string {
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
  // Viem wraps the useful line in a lot of context; the first is almost always it.
  return raw.split("\n")[0] ?? raw;
}

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
 * Two transactions, and the order matters: approve first, then create. A policy with no
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
    const wallet = ownerWallet();
    const fees = await arcFees(publicClient);

    // Exactly the budget, never max. If this contract is ever wrong, the blast radius is
    // the outstanding allowance rather than the owner's whole balance — ADR 0001.
    const approval = await wallet.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [ENGINE, params.budgetCap],
      chain: arcTestnet,
      account: wallet.account,
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
    const wallet = ownerWallet();
    const fees = await arcFees(publicClient);
    const hash = await wallet.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [ENGINE, amount],
      chain: arcTestnet,
      account: wallet.account,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({hash, timeout: 60_000});
    return hash;
  });
}
