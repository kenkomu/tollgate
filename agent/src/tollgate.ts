import {
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
   * Throws on refusal — the contract reverts with `PolicyViolation(reason)` and nothing
   * moves. Use `check` first if you want the reason without spending gas on a revert.
   */
  async spend(payee: Address, amount: bigint): Promise<SpendResult> {
    const {request, result} = await this.#publicClient.simulateContract({
      address: this.engine,
      abi: policyEngineAbi,
      functionName: "spend",
      args: [payee, amount],
      account: this.#account,
    });

    const txHash = await this.#walletClient.writeContract(request);
    await this.#publicClient.waitForTransactionReceipt({hash: txHash});

    return {
      txHash,
      explorerUrl: `${arcTestnet.blockExplorers.default.url}/tx/${txHash}`,
      spentTotal: result as bigint,
    };
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
