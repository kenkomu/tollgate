/**
 * A stub Arc node.
 *
 * The client's most important behaviours are its failure paths, and a live chain will not
 * produce them on request: you cannot ask Arc for a receipt that never arrives, or for three
 * payments to race for one nonce, or for a simulation that refuses. `selftest.ts` exercises
 * the happy paths against the real chain and spends real money doing it. This exercises the
 * rest, deterministically, for free.
 *
 * It is a stub, not a chain. It answers RPC calls from a small mutable state object; it does
 * not execute anything. Nothing here proves the *contract* is right — 47 Solidity tests do
 * that. This proves the client reacts correctly to what a chain says.
 */

import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  numberToHex,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import {MIN_GAS_PRICE_WEI, Reason, policyEngineAbi, usdc} from "@tollgate/shared";

export interface StubPolicy {
  agent: Address;
  owner: Address;
  expiry: bigint;
  paused: boolean;
  exists: boolean;
  budgetCap: bigint;
  spent: bigint;
  perTxCap: bigint;
  bucketCapacity: bigint;
  refillPerSecond: bigint;
  available: bigint;
  lastRefill: bigint;
}

export interface StubState {
  /** Native balance of the agent key, 18dp. */
  gasBalance: bigint;
  /** What `checkTransfer` answers. */
  checkReason: Reason;
  /** What simulating `trySpend` answers — deliberately separable from the above. */
  simulateReason: Reason;
  policy: StubPolicy;
  /** What `policyOf(agent)` answers. 0n means the key is unbound. */
  policyId: bigint;
  owner: Address;
  /** `null` means "no receipt yet", which is what an unconfirmed transaction looks like. */
  receiptStatus: "success" | "reverted" | null;
  gasEstimate: bigint;
  baseFeePerGas: bigint;
  blockNumber: bigint;
  /** Next nonce the node would hand out. Advanced only when a transaction is sent. */
  nonce: number;

  // ---- recorded for assertions ----
  calls: string[];
  sent: {nonce: number}[];
  /** Highest number of submissions in flight at once. Anything above 1 is a nonce race. */
  peakConcurrentSubmissions: number;
}

export const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
export const ENGINE = "0x8168eb562496A966f339a4bD165B924EeDce9873" as Address;
export const OWNER = "0x8dEa7F60FB144Ea127F6806302E6a83913348B69" as Address;
export const PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
export const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

export function stubPolicy(overrides: Partial<StubPolicy> = {}): StubPolicy {
  return {
    agent: "0x0000000000000000000000000000000000000000" as Address,
    owner: OWNER,
    expiry: 0n,
    paused: false,
    exists: true,
    budgetCap: usdc("100"),
    spent: usdc("10"),
    perTxCap: usdc("10"),
    bucketCapacity: usdc("4"),
    refillPerSecond: usdc("1"),
    available: usdc("4"),
    lastRefill: BigInt(Math.floor(Date.now() / 1000)),
    ...overrides,
  };
}

export function stubState(overrides: Partial<StubState> = {}): StubState {
  return {
    gasBalance: 10n ** 18n, // 1 USDC of gas, ~275 payments
    checkReason: Reason.OK,
    simulateReason: Reason.OK,
    policy: stubPolicy(),
    policyId: 1n,
    owner: OWNER,
    receiptStatus: "success",
    gasEstimate: 97_846n,
    baseFeePerGas: MIN_GAS_PRICE_WEI,
    blockNumber: 55_621_174n,
    nonce: 0,
    calls: [],
    sent: [],
    peakConcurrentSubmissions: 0,
    ...overrides,
  };
}

function block(state: StubState) {
  return {
    number: numberToHex(state.blockNumber),
    hash: `0x${"11".repeat(32)}`,
    parentHash: `0x${"22".repeat(32)}`,
    nonce: "0x0000000000000000",
    sha3Uncles: `0x${"00".repeat(32)}`,
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: `0x${"00".repeat(32)}`,
    stateRoot: `0x${"00".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    miner: "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: numberToHex(30_000_000n),
    gasUsed: numberToHex(1_000_000n),
    timestamp: numberToHex(BigInt(Math.floor(Date.now() / 1000))),
    baseFeePerGas: numberToHex(state.baseFeePerGas),
    transactions: [],
    uncles: [],
  };
}

function receipt(state: StubState) {
  if (state.receiptStatus === null) return null;
  return {
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: numberToHex(state.blockNumber),
    from: "0x0000000000000000000000000000000000000000",
    to: ENGINE,
    cumulativeGasUsed: "0x1",
    gasUsed: numberToHex(96_931n),
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: state.receiptStatus === "success" ? "0x1" : "0x0",
    effectiveGasPrice: numberToHex(state.baseFeePerGas),
    type: "0x2",
  };
}

/**
 * A JSON-RPC "method not found", exactly as a real node reports one.
 *
 * This matters more than it looks. viem probes optional methods — `eth_fillTransaction`
 * among them — and expects an unsupported one to fail *deterministically* so it can fall
 * back immediately. A stub that throws a plain Error instead is read as a transient fault
 * and retried three times with backoff, adding a second per probe and turning every
 * payment test into a two-second test. Answering the way a node answers keeps the stub
 * honest and the suite fast.
 */
class MethodNotFound extends Error {
  readonly code = -32601;
  constructor(method: string) {
    super(`the method ${method} does not exist/is not available`);
    this.name = "MethodNotFound";
  }
}

/** Builds a transport backed by `state`, which the test mutates between calls. */
export function stubTransport(state: StubState): Transport {
  let inFlight = 0;

  return custom({
    async request({method, params}: {method: string; params?: unknown}) {
      state.calls.push(method);
      const args = (params ?? []) as unknown[];

      switch (method) {
        case "eth_chainId":
          return numberToHex(5042002);

        case "eth_blockNumber":
          // The chain advances. A stub that returns a fixed height hangs anything that
          // waits for the next block — which is how `waitForTransactionReceipt` re-checks.
          state.blockNumber += 1n;
          return numberToHex(state.blockNumber);

        case "eth_getBlockByNumber":
        case "eth_getBlockByHash":
          return block(state);

        case "eth_getBalance":
          return numberToHex(state.gasBalance);

        case "eth_maxPriorityFeePerGas":
          return numberToHex(1_000_000_000n);

        case "eth_gasPrice":
          return numberToHex(state.baseFeePerGas);

        case "eth_estimateGas":
          return numberToHex(state.gasEstimate);

        case "eth_getTransactionCount":
          return numberToHex(state.nonce);

        case "eth_sendRawTransaction": {
          state.sent.push({nonce: state.nonce});
          state.nonce += 1;
          return TX_HASH;
        }

        case "eth_getTransactionReceipt":
          return receipt(state);

        case "eth_getTransactionByHash":
          return {
            hash: TX_HASH,
            nonce: numberToHex(0),
            blockHash: null,
            blockNumber: null,
            transactionIndex: null,
            from: "0x0000000000000000000000000000000000000000",
            to: ENGINE,
            value: "0x0",
            gas: numberToHex(state.gasEstimate),
            input: "0x",
            maxFeePerGas: numberToHex(state.baseFeePerGas),
            maxPriorityFeePerGas: numberToHex(1_000_000_000n),
            type: "0x2",
            chainId: numberToHex(5042002),
            v: "0x0",
            r: `0x${"00".repeat(32)}`,
            s: `0x${"00".repeat(32)}`,
          };

        case "eth_call": {
          const call = args[0] as {data: Hex};
          const {functionName} = decodeFunctionData({abi: policyEngineAbi, data: call.data});

          switch (functionName) {
            case "checkTransfer":
              return encodeFunctionResult({
                abi: policyEngineAbi,
                functionName: "checkTransfer",
                result: state.checkReason,
              });

            case "trySpend": {
              // A simulated write. Counting concurrency here is what catches a nonce race:
              // the queue is meant to keep exactly one submission sequence alive at a time.
              inFlight += 1;
              state.peakConcurrentSubmissions = Math.max(state.peakConcurrentSubmissions, inFlight);
              await new Promise((resolve) => setTimeout(resolve, 5));
              inFlight -= 1;
              return encodeFunctionResult({
                abi: policyEngineAbi,
                functionName: "trySpend",
                result: state.simulateReason,
              });
            }

            case "getPolicy":
              return encodeFunctionResult({
                abi: policyEngineAbi,
                functionName: "getPolicy",
                result: state.policy,
              });

            case "policyOf":
              return encodeFunctionResult({
                abi: policyEngineAbi,
                functionName: "policyOf",
                result: state.policyId,
              });

            case "ownerOf":
              return encodeFunctionResult({
                abi: policyEngineAbi,
                functionName: "ownerOf",
                result: state.owner,
              });

            case "availableNow":
              return encodeFunctionResult({
                abi: policyEngineAbi,
                functionName: "availableNow",
                result: state.policy.available,
              });

            case "remainingBudget":
              return encodeFunctionResult({
                abi: policyEngineAbi,
                functionName: "remainingBudget",
                result: state.policy.budgetCap - state.policy.spent,
              });

            default:
              throw new Error(`stub node has no answer for ${functionName}`);
          }
        }

        default:
          // Arc does not implement every optional method either; this is the honest answer.
          throw new MethodNotFound(method);
      }
    },
  });
}
