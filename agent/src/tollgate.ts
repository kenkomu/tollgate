import {
  arcFees,
  arcTestnet,
  policyEngineAbi,
  Reason,
  explainToAgent,
  isRetryable,
  reasonName,
  type Policy,
} from "@tollgate/shared";
import {createPublicClient, createWalletClient, http, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

/**
 * The payment was submitted and we stopped waiting before it resolved.
 *
 * This is the outcome that has to be handled carefully, because it is the one that looks
 * like a failure and is not. The transaction may still be in the mempool and may still
 * land. Retrying on this error is how you pay twice.
 *
 * The only safe response is to resolve the original transaction — see `verify` — before
 * deciding anything. Note that the policy caps still bound the damage of a double payment;
 * this is about the agent's own bookkeeping being wrong, not about the leash failing.
 */
export class PaymentInFlightError extends Error {
  readonly txHash: Hex;
  readonly explorerUrl: string;

  constructor(txHash: Hex, explorerUrl: string) {
    super(
      `Payment ${txHash} was submitted but did not confirm in time. It may still land. ` +
        `Do not retry: verify this transaction first.`,
    );
    this.name = "PaymentInFlightError";
    this.txHash = txHash;
    this.explorerUrl = explorerUrl;
  }
}

/**
 * The payment was mined and reverted.
 *
 * Reaching this means policy changed between the pre-flight check and execution — the
 * owner hit pause, revoked a payee, or spent the balance elsewhere in the intervening
 * blocks. The check is advisory; only execution is authoritative. Nothing moved.
 */
export class PaymentRevertedError extends Error {
  readonly txHash: Hex;
  readonly explorerUrl: string;

  constructor(txHash: Hex, explorerUrl: string) {
    super(`Payment ${txHash} was mined but reverted. Nothing moved. Policy changed under it.`);
    this.name = "PaymentRevertedError";
    this.txHash = txHash;
    this.explorerUrl = explorerUrl;
  }
}

/**
 * The Tollgate client — the surface an agent framework integrates against.
 *
 * This is a first cut of what §5.3 of the plan calls the real product. The shape that
 * matters: `check` never throws, and always answers three questions the agent actually
 * needs — is it allowed, why not, and would waiting help. An agent that cannot tell
 * "back off and retry" from "a human must act" is the looping-agent failure this whole
 * product exists to contain.
 */

export interface CheckResult {
  allowed: boolean;
  reason: Reason;
  reasonName: string;
  /** What the agent should do about it, in words. */
  message: string;
  /** True only when backing off and retrying the identical call could succeed. */
  retryable: boolean;
}

export interface SpendResult {
  txHash: Hex;
  explorerUrl: string;
  spentTotal: bigint;
}

export interface TollgateConfig {
  engine: Address;
  agentPrivateKey: Hex;
  rpcUrl?: string;
}

export class TollgateClient {
  readonly engine: Address;
  readonly agentAddress: Address;

  #publicClient;
  #walletClient;
  #account;

  constructor(config: TollgateConfig) {
    this.engine = config.engine;
    this.#account = privateKeyToAccount(config.agentPrivateKey);
    this.agentAddress = this.#account.address;

    const transport = http(config.rpcUrl ?? arcTestnet.rpcUrls.default.http[0]);
    this.#publicClient = createPublicClient({chain: arcTestnet, transport});
    this.#walletClient = createWalletClient({
      account: this.#account,
      chain: arcTestnet,
      transport,
    });
  }

  /**
   * Would this payment be permitted right now?
   *
   * A pure read — costs no gas, changes nothing, and never throws on a refusal. Always
   * call this before `spend`, so a refused payment costs the agent nothing at all.
   */
  async check(payee: Address, amount: bigint): Promise<CheckResult> {
    const raw = await this.#publicClient.readContract({
      address: this.engine,
      abi: policyEngineAbi,
      functionName: "checkTransfer",
      args: [this.agentAddress, payee, amount],
    });

    const reason = Number(raw) as Reason;
    return {
      allowed: reason === Reason.OK,
      reason,
      reasonName: reasonName(reason),
      message: explainToAgent(reason),
      retryable: isRetryable(reason),
    };
  }

  /**
   * Attempt the payment.
   *
   * Three failure shapes, deliberately distinct, because the correct response differs:
   *
   *   - Refused up front. The simulation reverts with `PolicyViolation(reason)`, no
   *     transaction is ever sent, and nothing is spent — not even gas.
   *   - `PaymentRevertedError`. Mined, reverted, nothing moved. Safe to reassess.
   *   - `PaymentInFlightError`. Submitted, unresolved. NOT safe to retry.
   *
   * Collapsing the last two into one error is the dangerous simplification: one means the
   * money definitely did not move, the other means we do not know.
   */
  async spend(payee: Address, amount: bigint, timeoutMs = 90_000): Promise<SpendResult> {
    // Fees are settled before simulating so the simulated transaction and the submitted
    // one are the same shape, rather than the second being the first plus an override.
    const fees = await arcFees(this.#publicClient);

    const {request, result} = await this.#publicClient.simulateContract({
      address: this.engine,
      abi: policyEngineAbi,
      functionName: "spend",
      args: [payee, amount],
      account: this.#account,
      ...fees,
    });

    const txHash = await this.#walletClient.writeContract(request);
    const explorerUrl = `${arcTestnet.blockExplorers.default.url}/tx/${txHash}`;

    let receipt;
    try {
      receipt = await this.#publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: timeoutMs,
      });
    } catch {
      // Everything that lands here is "we stopped watching", never "it failed".
      throw new PaymentInFlightError(txHash, explorerUrl);
    }

    // Simulation passed, so a revert here means state moved under us between the two.
    if (receipt.status !== "success") throw new PaymentRevertedError(txHash, explorerUrl);

    return {txHash, explorerUrl, spentTotal: result as bigint};
  }

  /**
   * Resolve a payment whose outcome is unknown.
   *
   * The counterpart to `PaymentInFlightError`, and the only correct thing to call after
   * one. Answers the sole question that matters — did this move money — from chain rather
   * than from anything we remember.
   */
  async verify(txHash: Hex): Promise<{settled: boolean; succeeded: boolean}> {
    try {
      const receipt = await this.#publicClient.getTransactionReceipt({hash: txHash});
      return {settled: true, succeeded: receipt.status === "success"};
    } catch {
      // No receipt yet: still pending, or dropped from the mempool. Either way unresolved,
      // and reporting "did not happen" here would be a guess presented as a fact.
      return {settled: false, succeeded: false};
    }
  }

  /** The policy governing this agent, as stored on chain. */
  async getPolicy(owner: Address): Promise<Policy> {
    const p = await this.#publicClient.readContract({
      address: this.engine,
      abi: policyEngineAbi,
      functionName: "getPolicy",
      args: [owner],
    });
    return p as unknown as Policy;
  }

  /** Who owns the policy this agent is bound to, or the zero address if unbound. */
  async owner(): Promise<Address> {
    return (await this.#publicClient.readContract({
      address: this.engine,
      abi: policyEngineAbi,
      functionName: "ownerOf",
      args: [this.agentAddress],
    })) as Address;
  }

  /** Velocity headroom right now, in 6-decimal USDC. */
  async availableNow(owner: Address): Promise<bigint> {
    return (await this.#publicClient.readContract({
      address: this.engine,
      abi: policyEngineAbi,
      functionName: "availableNow",
      args: [owner],
    })) as bigint;
  }

  /** Remaining lifetime budget, in 6-decimal USDC. */
  async remainingBudget(owner: Address): Promise<bigint> {
    return (await this.#publicClient.readContract({
      address: this.engine,
      abi: policyEngineAbi,
      functionName: "remainingBudget",
      args: [owner],
    })) as bigint;
  }

  /** Gas balance of the agent key itself — 18dp native USDC, not the owner's budget. */
  async gasBalance(): Promise<bigint> {
    return this.#publicClient.getBalance({address: this.agentAddress});
  }
}
