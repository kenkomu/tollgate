import {
  availableNow,
  secondsUntilAvailable,
  withGasBuffer,
  arcFees,
  arcTestnet,
  ARC_POLLING_INTERVAL_MS,
  policyEngineAbi,
  Reason,
  explainToAgent,
  isRetryable,
  reasonName,
  type Policy,
} from "@tollgate/shared";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  type Address,
  type Hex,
  type Transport,
} from "viem";
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
 * Policy refused the payment, and the refusal is now on chain.
 *
 * Distinct from the two errors below because nothing went wrong here — the system worked.
 * The transaction succeeded, a `Refused` event was written, and no funds moved. The agent
 * is told in the same terms an owner would read.
 */
export class PolicyRefusedError extends Error {
  readonly reason: Reason;
  readonly reasonName: string;
  readonly retryable: boolean;
  readonly txHash: Hex;
  readonly explorerUrl: string;

  constructor(reason: Reason, txHash: Hex, explorerUrl: string) {
    super(`REFUSED by policy: ${reasonName(reason)}. ${explainToAgent(reason)} Nothing was spent.`);
    this.name = "PolicyRefusedError";
    this.reason = reason;
    this.reasonName = reasonName(reason);
    this.retryable = isRetryable(reason);
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
  /** Seconds spent waiting for velocity headroom before this went through. */
  waitedSeconds?: number;
}

/**
 * The bucket will refill, but not soon enough to be worth blocking on.
 *
 * Distinct from a refusal because nothing was refused — the payment is simply not
 * possible yet. The agent is told exactly how long, so it can decide whether to reschedule
 * or tell the owner the rate limit is set too low for the work it has been given.
 */
export class VelocityWaitTooLongError extends Error {
  readonly seconds: number;

  constructor(seconds: number, limit: number) {
    super(
      `Rate limit: this payment needs ${seconds}s of refill, beyond the ${limit}s this call ` +
        `will wait. Nothing was submitted. Retry later, or ask the owner to raise the rate.`,
    );
    this.name = "VelocityWaitTooLongError";
    this.seconds = seconds;
  }
}

/**
 * The agent's own gas has run out.
 *
 * Worth its own error because it is the failure most easily mistaken for a policy
 * refusal, and the remedy is the opposite. On Arc gas is USDC, so the agent key holds a
 * second pot of money entirely separate from the owner's budget — a policy with $10 of
 * headroom is useless to an agent whose own key is empty. Reporting that as "refused"
 * would send everyone to look at the wrong thing.
 */
export class GasExhaustedError extends Error {
  readonly balance: bigint;

  constructor(balance: bigint, needed: bigint) {
    super(
      `The agent key cannot pay for gas. It holds ${formatUnits(balance, 18)} USDC and needs ` +
        `at least ${formatUnits(needed, 18)} to submit. This is NOT a policy refusal — the ` +
        `owner's budget is untouched. Fund the agent key itself at https://faucet.circle.com.`,
    );
    this.name = "GasExhaustedError";
    this.balance = balance;
  }
}

/**
 * Roughly what one `trySpend` costs on Arc.
 *
 * Measured, not guessed: 99,535 gas at 20.2 Gwei on a live payment. Rounded up, and used
 * only to decide whether the key can afford to try — never to price a transaction.
 */
const GAS_PER_SPEND_WEI = 120_000n * 30_000_000_000n; // ~0.0036 USDC

/** Below this the agent can still act but should say something. Ten or so payments. */
const LOW_GAS_WEI = GAS_PER_SPEND_WEI * 10n;

export interface TollgateConfig {
  engine: Address;
  agentPrivateKey: Hex;
  rpcUrl?: string;
  /**
   * Override the network transport.
   *
   * Exists so the client can be driven against a stub node in tests. The paths worth
   * testing here are the ones a live chain will not reproduce on demand — a receipt that
   * never arrives, a simulation that refuses, three payments racing for one nonce — and
   * without this seam none of them is reachable except by spending real money and hoping
   * for the right weather. Production passes `rpcUrl` and never touches this.
   */
  transport?: Transport;
}

export class TollgateClient {
  readonly engine: Address;
  readonly agentAddress: Address;

  #publicClient;
  #walletClient;
  #account;

  /**
   * Submissions run one at a time.
   *
   * Two concurrent `spend` calls each fetch the account nonce, get the same number, and
   * the second is dropped as a replacement — or worse, silently replaces the first. An
   * agent doing three purchases in parallel is not an exotic case, it is the obvious way
   * to write the loop. Serialising here means callers never have to know that.
   */
  #queue: Promise<unknown> = Promise.resolve();

  #serialise<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    // Keep the chain alive after a rejection, or one failed payment stalls every later one.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  constructor(config: TollgateConfig) {
    this.engine = config.engine;
    this.#account = privateKeyToAccount(config.agentPrivateKey);
    this.agentAddress = this.#account.address;

    const transport = config.transport ?? http(config.rpcUrl ?? arcTestnet.rpcUrls.default.http[0]);
    this.#publicClient = createPublicClient({
      chain: arcTestnet,
      transport,
      // viem's 4s default is tuned for Ethereum's block time; Arc settles in under a second.
      pollingInterval: ARC_POLLING_INTERVAL_MS,
    });
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
  async spend(
    payee: Address,
    amount: bigint,
    opts: {timeoutMs?: number; waitForVelocity?: boolean; maxWaitSeconds?: number} = {},
  ): Promise<SpendResult> {
    return this.#serialise(() => this.#spend(payee, amount, opts));
  }

  async #spend(
    payee: Address,
    amount: bigint,
    {timeoutMs = 90_000, waitForVelocity = true, maxWaitSeconds = 300}: {
      timeoutMs?: number;
      waitForVelocity?: boolean;
      maxWaitSeconds?: number;
    },
  ): Promise<SpendResult> {
    // Can this key afford to try at all? Asked before anything else, because running out
    // of gas mid-loop otherwise surfaces as an incomprehensible RPC error.
    const gas = await this.gasBalance();
    if (gas < GAS_PER_SPEND_WEI) throw new GasExhaustedError(gas, GAS_PER_SPEND_WEI);

    let waitedSeconds = 0;

    // Velocity is the one refusal where waiting is the correct answer, so it gets handled
    // before submitting rather than recorded as a refusal. Everything else is submitted
    // and goes on the record — but an audit log full of "briefly rate-limited" would bury
    // the entries that actually matter, and the owner learns nothing from them.
    if (waitForVelocity) {
      const pre = await this.check(payee, amount);
      if (pre.reason === Reason.EXCEEDS_VELOCITY) {
        const owner = await this.owner();
        const policy = await this.getPolicy(owner);
        const seconds = secondsUntilAvailable(
          availableNow(policy),
          amount,
          policy.refillPerSecond,
          policy.bucketCapacity,
        );

        if (seconds === null) {
          // The bucket will never hold this much. Waiting cannot help; submit and let the
          // refusal be recorded, because this one is a real policy mismatch.
        } else if (seconds > maxWaitSeconds) {
          throw new VelocityWaitTooLongError(seconds, maxWaitSeconds);
        } else {
          await new Promise((resolve) => setTimeout(resolve, (seconds + 1) * 1000));
          waitedSeconds = seconds + 1;
        }
      }
    }

    const result = await this.#submit(payee, amount, timeoutMs);
    return waitedSeconds ? {...result, waitedSeconds} : result;
  }

  async #submit(payee: Address, amount: bigint, timeoutMs: number): Promise<SpendResult> {
    // Fees are settled before simulating so the simulated transaction and the submitted
    // one are the same shape, rather than the second being the first plus an override.
    const fees = await arcFees(this.#publicClient);

    // `trySpend`, not `spend`.
    //
    // The reverting variant is cheaper for the agent — a refused attempt costs no gas at
    // all — and it leaves the owner with a log containing every payment their agent made
    // and no trace of anything it was stopped from making. That is the wrong trade for
    // the party who is actually at risk. Paying ~$0.0007 to put "your agent tried to send
    // $1,000 to a burn address and was blocked" permanently on chain is the entire point
    // of the product, and it is not the agent's call to opt out of being watched.
    const call = {
      address: this.engine,
      abi: policyEngineAbi,
      functionName: "trySpend",
      args: [payee, amount],
      account: this.#account,
      ...fees,
    } as const;

    // Arc's estimate leaves under 1% of headroom on a USDC transfer, which is not enough —
    // see GAS_BUFFER_PERCENT. Unused gas is refunded, so the buffer costs nothing.
    const gas = withGasBuffer(await this.#publicClient.estimateContractGas(call));

    const {request, result} = await this.#publicClient.simulateContract({...call, gas});

    // The simulation already told us the answer. Refusals are still surfaced to the agent
    // as a thrown `PolicyRefusedError`, so nothing downstream can mistake one for a
    // payment — but we submit anyway, because the record is the product.
    const simulated = Number(result) as Reason;

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

    // `trySpend` does not revert on a policy refusal, so a failed receipt here is a real
    // execution failure — out of gas, or a transfer the token itself rejected.
    if (receipt.status !== "success") throw new PaymentRevertedError(txHash, explorerUrl);

    if (simulated !== Reason.OK) throw new PolicyRefusedError(simulated, txHash, explorerUrl);

    const spentTotal = await this.remainingBudgetToSpent();
    return {txHash, explorerUrl, spentTotal};
  }

  /** Lifetime spend, read back from chain rather than inferred from a return value. */
  private async remainingBudgetToSpent(): Promise<bigint> {
    const owner = await this.owner();
    const policy = await this.getPolicy(owner);
    return policy.spent;
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

  /**
   * Unstick a transaction that never confirmed.
   *
   * The counterpart to `PaymentInFlightError`, and the reason `verify` alone was not
   * enough: knowing a payment is unresolved does not resolve it. A stuck transaction on
   * Arc is almost always underpriced against the 20 Gwei floor, and it blocks every later
   * transaction from this key, because nonces are sequential — one stuck payment stalls
   * the whole agent.
   *
   * Both paths reuse the original nonce, which is what makes them a replacement rather
   * than a second payment. There is no way to have both: the original either lands or it
   * does not, and the replacement decides which.
   *
   * @param mode `"speed-up"` rebroadcasts the same call at a higher fee — use when the
   *             payment should still happen. `"cancel"` replaces it with a zero-value
   *             self-send — use when it should not.
   */
  async unstick(txHash: Hex, mode: "speed-up" | "cancel" = "speed-up"): Promise<
    {outcome: "already-settled"; succeeded: boolean} | {outcome: "replaced"; txHash: Hex; explorerUrl: string}
  > {
    return this.#serialise(async () => {
      const settled = await this.verify(txHash);
      if (settled.settled) return {outcome: "already-settled" as const, succeeded: settled.succeeded};

      const original = await this.#publicClient.getTransaction({hash: txHash});
      const fees = await arcFees(this.#publicClient);

      // A replacement must beat the original meaningfully or the node keeps the first.
      // Doubling is blunt and reliable; the alternative is guessing a node's exact policy.
      const bump = (a: bigint, b: bigint) => (a > b ? a : b) * 2n;
      const maxFeePerGas = bump(fees.maxFeePerGas, original.maxFeePerGas ?? 0n);
      const maxPriorityFeePerGas = bump(fees.maxPriorityFeePerGas, original.maxPriorityFeePerGas ?? 0n);

      const replacement =
        mode === "cancel"
          ? await this.#walletClient.sendTransaction({
              to: this.agentAddress,
              value: 0n,
              nonce: original.nonce,
              maxFeePerGas,
              maxPriorityFeePerGas,
              account: this.#account,
              chain: arcTestnet,
            })
          : await this.#walletClient.sendTransaction({
              to: original.to ?? this.engine,
              data: original.input,
              value: original.value,
              nonce: original.nonce,
              maxFeePerGas,
              maxPriorityFeePerGas,
              account: this.#account,
              chain: arcTestnet,
            });

      await this.#publicClient.waitForTransactionReceipt({hash: replacement, timeout: 90_000});

      return {
        outcome: "replaced" as const,
        txHash: replacement,
        explorerUrl: `${arcTestnet.blockExplorers.default.url}/tx/${replacement}`,
      };
    });
  }

  /**
   * Can this key keep working?
   *
   * The owner's budget and the agent's gas are two different pots, and only one of them
   * is visible on the dashboard. An agent that runs dry mid-task fails in a way that looks
   * like a policy problem and is not.
   */
  async gasHealth(): Promise<{balance: bigint; paymentsLeft: number; low: boolean; empty: boolean}> {
    const balance = await this.gasBalance();
    return {
      balance,
      paymentsLeft: Number(balance / GAS_PER_SPEND_WEI),
      low: balance < LOW_GAS_WEI,
      empty: balance < GAS_PER_SPEND_WEI,
    };
  }

  /** Gas balance of the agent key itself — 18dp native USDC, not the owner's budget. */
  async gasBalance(): Promise<bigint> {
    return this.#publicClient.getBalance({address: this.agentAddress});
  }
}
