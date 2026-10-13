/**
 * Can I run the demo right now?
 *
 * One command that answers it, because the failure it prevents is the expensive one: the
 * agent gets three payments into a recorded run and stops with INSUFFICIENT_BALANCE, which
 * looks exactly like the enforcement layer working and is actually an empty wallet.
 *
 * Every number here is read from chain. Nothing is cached and nothing is inferred.
 */

import {createPublicClient, erc20Abi, formatUnits, http, type Address} from "viem";
import {
  FAUCET_URL,
  USDC_ADDRESS,
  activeChain,
  availableNow,
  explorerAddress,
  formatUsdc,
  policyEngineAbi,
  type Policy,
} from "@tollgate/shared";

const engine = process.env.POLICY_ENGINE_ADDRESS as Address | undefined;
const owner = process.env.OWNER_ADDRESS as Address | undefined;
const agent = process.env.AGENT_ADDRESS as Address | undefined;
const payee = process.env.PAYEE_ADDRESS as Address | undefined;

if (!engine || !owner) {
  console.error("Need POLICY_ENGINE_ADDRESS and OWNER_ADDRESS in .env");
  process.exit(1);
}

const client = createPublicClient({chain: activeChain, transport: http(process.env.ARC_RPC_URL)});

/** One `spend` costs roughly this much gas on Arc, measured rather than guessed. */
const GAS_PER_PAYMENT = 120_000n * 30_000_000_000n;

async function usdcOf(address: Address): Promise<bigint> {
  return client.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

// The agent's own policy when we know the agent, otherwise the owner's first. An owner can
// run several agents (ADR 0010); this report is about the one this .env drives.
const policyId = agent
  ? await client.readContract({address: engine, abi: policyEngineAbi, functionName: "policyOf", args: [agent]})
  : ((await client.readContract({address: engine, abi: policyEngineAbi, functionName: "policiesOf", args: [owner]}))[0] ??
    0n);

const [policy, ownerUsdc, allowance, agentGas, payeeUsdc] = await Promise.all([
  client.readContract({
    address: engine,
    abi: policyEngineAbi,
    functionName: "getPolicy",
    args: [policyId],
  }) as Promise<unknown> as Promise<Policy>,
  usdcOf(owner),
  client.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, engine],
  }),
  agent ? client.getBalance({address: agent}) : Promise.resolve(0n),
  payee ? usdcOf(payee) : Promise.resolve(0n),
]);

const problems: string[] = [];
const notes: string[] = [];

console.log(`\n  contract  ${engine}`);
console.log(`            ${explorerAddress(engine)}\n`);

if (!policy.exists) {
  problems.push(`No policy exists for ${owner}. Create one from the dashboard's Policy page.`);
} else {
  const headroom = availableNow(policy);
  const remaining = policy.budgetCap > policy.spent ? policy.budgetCap - policy.spent : 0n;

  console.log(`  policy`);
  console.log(`    agent            ${policy.agent}`);
  console.log(`    budget           ${formatUsdc(policy.spent)} spent of ${formatUsdc(policy.budgetCap)}`);
  console.log(`    remaining        ${formatUsdc(remaining)}`);
  console.log(`    per-payment cap  ${formatUsdc(policy.perTxCap)}`);
  console.log(`    rate headroom    ${formatUsdc(headroom)} of ${formatUsdc(policy.bucketCapacity)}`);
  console.log(`    paused           ${policy.paused ? "YES — nothing can move" : "no"}`);

  if (policy.paused) problems.push("The policy is paused. Resume it before demoing a payment.");
  if (remaining === 0n) problems.push("The lifetime budget is exhausted. Raise it on the Policy page.");
  if (agent && policy.agent.toLowerCase() !== agent.toLowerCase()) {
    problems.push(
      `AGENT_ADDRESS (${agent}) is not the agent bound to this policy (${policy.agent}). ` +
        `The agent's payments will be refused with NOT_AGENT.`,
    );
  }
}

console.log(`\n  balances`);
console.log(`    owner  ${owner}`);
console.log(`      USDC to spend  ${formatUsdc(ownerUsdc)}`);
console.log(`      approved       ${formatUsdc(allowance)}`);
if (agent) {
  console.log(`    agent  ${agent}`);
  console.log(`      gas            ${Number(formatUnits(agentGas, 18)).toFixed(4)} USDC`);
  console.log(`      affords        ~${agentGas / GAS_PER_PAYMENT} payments`);
}
if (payee) {
  console.log(`    payee  ${payee}`);
  console.log(`      received       ${formatUsdc(payeeUsdc)}`);
}

/**
 * The owner's wallet is the one that actually empties.
 *
 * Money leaves the owner and never comes back — the payee keeps it. Gas is the opposite:
 * the agent spends fractions of a cent per payment and a single faucet drip lasts for
 * thousands. So the balance that ends a demo early is almost always this one.
 */
const spendable = ownerUsdc < allowance ? ownerUsdc : allowance;
if (spendable < 1_000_000n) {
  problems.push(
    `Owner can only cover ${formatUsdc(spendable)} of payments ` +
      `(balance ${formatUsdc(ownerUsdc)}, approved ${formatUsdc(allowance)}). Top up at ${FAUCET_URL}.`,
  );
} else if (spendable < 5_000_000n) {
  notes.push(`Owner can cover ${formatUsdc(spendable)} — enough for a short run, not a long one.`);
}

if (ownerUsdc > allowance) {
  notes.push(
    `Allowance (${formatUsdc(allowance)}) is below the wallet balance (${formatUsdc(ownerUsdc)}), ` +
      `so the allowance is the binding ceiling. Raise it on the Policy page if that is not intended.`,
  );
}

if (agent && agentGas < GAS_PER_PAYMENT * 20n) {
  problems.push(`Agent key is low on gas. Fund ${agent} at ${FAUCET_URL}.`);
}

console.log("");
for (const note of notes) console.log(`  note     ${note}`);
for (const problem of problems) console.log(`  BLOCKER  ${problem}`);

console.log(
  problems.length === 0
    ? `\n  ready to demo\n`
    : `\n  ${problems.length} thing(s) to fix before demoing\n`,
);

process.exit(problems.length === 0 ? 0 : 1);
