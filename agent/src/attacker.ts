import {
  activeChain,
  formatUsdc,
  policyEngineAbi,
  reasonName,
  Reason,
  USDC_ADDRESS,
  type Policy,
} from "@tollgate/shared";
import {PolicyRefusedError, TollgateClient} from "@tollgate/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  erc20Abi,
  http,
  type Address,
  type Hex,
} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {banner, bold, dim, field, green, grey, red} from "./ui.ts";

/**
 * The scripted attacker.
 *
 * The compromised-agent demo proves the claim only as well as the model chooses to attack.
 * This does not choose: it holds the real agent key and runs every evasion we know of, in a
 * fixed order, every time. If the guarantee holds, all of them are blocked; if any gets
 * through, the run fails loudly and exits non-zero.
 *
 * Dry run by default, and free: policy attacks ask the contract's own `checkTransfer` view,
 * owner-function attacks are simulated with the agent's key as the sender. Nothing is sent.
 *
 * `--submit` also sends the policy attacks as real `trySpend` transactions, so each refusal
 * lands on chain as a `Refused` event, the evidence the dashboard's activity log shows.
 * That costs the agent a little gas and moves no money.
 *
 *   pnpm attack            # dry run
 *   pnpm attack --submit   # leave the refusals on chain
 */

type Outcome = {blocked: true; by: string} | {blocked: false; detail: string} | {skipped: string};

interface Attack {
  id: string;
  /** What an attacker holding the agent key would try. */
  tactic: string;
  run(): Promise<Outcome>;
  /** For policy attacks under --submit: the payment to actually attempt. */
  submit?: {payee: Address; amount: bigint};
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(red(`\n  Missing ${name} in .env\n`));
    process.exit(1);
  }
  return value;
}

/** The custom error a reverted simulation carried, by name, or the short message. */
function revertName(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name === "PolicyViolation") return `PolicyViolation(${reasonName(Number(revert.data?.args?.[0]) as Reason)})`;
      // A plain require() string arrives as the built-in `Error(string)`; its text is the useful part.
      if (revert.reason) return `"${revert.reason}"`;
      if (name) return name;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

async function main(): Promise<void> {
  const submit = process.argv.includes("--submit");
  const engine = required("POLICY_ENGINE_ADDRESS") as Address;
  const agentKey = required("AGENT_PRIVATE_KEY") as Hex;

  const agent = privateKeyToAccount(agentKey);
  const client = new TollgateClient({engine, agentPrivateKey: agentKey, rpcUrl: process.env.ARC_RPC_URL});
  const chain = createPublicClient({chain: activeChain, transport: http(process.env.ARC_RPC_URL)});

  const owner = await client.owner();
  if (owner === "0x0000000000000000000000000000000000000000") {
    console.error(red(`\n  This agent key has no policy bound to it on ${engine}. Nothing to attack.\n`));
    process.exit(1);
  }

  const policy: Policy = await client.getPolicy(owner);
  const available = await client.availableNow(owner);
  const remaining = policy.budgetCap - policy.spent;
  // An address nobody has ever approved, fresh each run so it cannot be on the allowlist.
  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  const payee = (process.env.PAYEE_ADDRESS as Address | undefined) ?? null;
  const payeeAllowed = payee ? await client.isAllowedPayee(owner, payee) : false;

  /** A policy attack: does the contract allow this payment? */
  const pay = (to: Address, amount: bigint) => async (): Promise<Outcome> => {
    const result = await client.check(to, amount);
    return result.allowed
      ? {blocked: false, detail: `checkTransfer returned OK for ${formatUsdc(amount)} to ${to}`}
      : {blocked: true, by: result.reasonName};
  };

  /** An owner-function attack: does the contract accept this call from the agent's key? */
  const call =
    (functionName: string, args: readonly unknown[], address: Address = engine, abi: unknown = policyEngineAbi) =>
    async (): Promise<Outcome> => {
      try {
        await chain.simulateContract({
          account: agent,
          address,
          abi: abi as typeof policyEngineAbi,
          functionName: functionName as never,
          args: args as never,
        });
        return {blocked: false, detail: `${functionName} succeeded when sent from the agent key`};
      } catch (error) {
        return {blocked: true, by: revertName(error)};
      }
    };

  const needsPayee = (why: string): Outcome => ({
    skipped: payee
      ? `${why}: PAYEE_ADDRESS is not on the allowlist, so the payee rule would hide the one under test`
      : `${why}: set PAYEE_ADDRESS to an allowlisted payee`,
  });

  const big = 10n ** 30n;

  const attacks: Attack[] = [
    {
      id: "unknown-payee",
      tactic: "Pay an address the owner never approved",
      run: pay(stranger, 10_000n),
      submit: {payee: stranger, amount: 10_000n},
    },
    {
      id: "pay-the-contract",
      tactic: "Pay the policy contract itself, to strand the funds",
      run: pay(engine, 10_000n),
    },
    {
      id: "over-per-payment",
      tactic: "One payment just over the per-payment cap",
      run: payee && payeeAllowed ? pay(payee, policy.perTxCap + 1n) : async () => needsPayee("over-per-payment"),
      ...(payee && payeeAllowed ? {submit: {payee, amount: policy.perTxCap + 1n}} : {}),
    },
    {
      id: "over-budget",
      tactic: "Ask for more than the lifetime budget has left",
      run: async () => {
        if (!payee || !payeeAllowed) return needsPayee("over-budget");
        // The budget rule can only be shown on its own when what is left fits in one payment;
        // otherwise the per-payment cap refuses first and this would prove the wrong rule.
        if (remaining + 1n > policy.perTxCap) {
          return {
            skipped: `over-budget: ${formatUsdc(remaining)} is left and one payment is capped at ${formatUsdc(policy.perTxCap)}, so the per-payment cap would refuse first`,
          };
        }
        return pay(payee, remaining + 1n)();
      },
    },
    {
      id: "burst",
      tactic: "Spend faster than the rate limit refills",
      run: async () => {
        if (!payee || !payeeAllowed) return needsPayee("burst");
        // Only testable in one call when the bucket holds less than a single payment can carry.
        if (available + 1n > policy.perTxCap) {
          return {skipped: `burst: the bucket (${formatUsdc(available)}) is fuller than one payment can be; drain it with real payments first`};
        }
        return pay(payee, available + 1n)();
      },
    },
    {
      id: "allowlist-itself",
      tactic: "Add its own address to the allowlist",
      run: call("setPayee", [stranger, true]),
    },
    {
      id: "raise-caps",
      tactic: "Raise the budget and per-payment caps",
      run: call("setCaps", [big, big]),
    },
    {
      id: "unpause",
      tactic: "Lift a pause the owner set",
      run: call("setPaused", [false]),
    },
    {
      id: "steal-the-binding",
      tactic: "Create a policy of its own for its own key",
      run: call("createPolicy", [agent.address, big, big, big, big, 0n]),
    },
    {
      id: "direct-spend",
      tactic: "Call spend directly instead of the polite trySpend",
      run: call("spend", [stranger, 10_000n]),
    },
    {
      id: "go-around",
      tactic: "Skip Tollgate: transferFrom the owner's USDC straight to itself",
      run: call("transferFrom", [owner, agent.address, 10_000n], USDC_ADDRESS, erc20Abi),
    },
  ];

  banner("Scripted attacker", submit ? "Every known evasion, sent on chain" : "Every known evasion, dry run");
  field("chain", `${activeChain.name} (${activeChain.id})`);
  field("policy engine", dim(engine));
  field("owner", dim(owner));
  field("agent key", `${dim(agent.address)} ${grey("(the attacker holds this)")}`);
  field("policy", `${formatUsdc(remaining)} left · ${formatUsdc(policy.perTxCap)} per payment${policy.paused ? " · PAUSED" : ""}`);
  console.log("");

  let breaches = 0;
  let blocked = 0;
  let skipped = 0;

  for (const attack of attacks) {
    let outcome: Outcome;
    try {
      outcome = await attack.run();
    } catch (error) {
      outcome = {skipped: `could not run: ${revertName(error)}`};
    }

    if ("skipped" in outcome) {
      skipped++;
      console.log(`  ${grey("–")} ${attack.tactic}\n      ${grey(`skipped · ${outcome.skipped}`)}`);
      continue;
    }

    if (!outcome.blocked) {
      breaches++;
      console.log(`  ${red("✗ BREACH")} ${bold(attack.tactic)}\n      ${red(outcome.detail)}`);
      continue;
    }

    blocked++;
    let proof = "";
    if (submit && attack.submit) {
      try {
        await client.spend(attack.submit.payee, attack.submit.amount);
        breaches++;
        console.log(`  ${red("✗ BREACH")} ${bold(attack.tactic)}\n      ${red("the payment went through on chain")}`);
        continue;
      } catch (error) {
        proof = error instanceof PolicyRefusedError ? ` · on chain: ${error.explorerUrl}` : ` · not submitted: ${revertName(error)}`;
      }
    }
    console.log(`  ${green("✓ blocked")} ${attack.tactic}\n      ${grey(`by ${outcome.by}${proof}`)}`);
  }

  console.log("");
  const summary = `${blocked} blocked · ${breaches} got through · ${skipped} skipped`;
  if (breaches > 0) {
    console.log(red(bold(`  ${summary}. The guarantee did not hold.\n`)));
    process.exit(1);
  }
  console.log(green(bold(`  ${summary}. Nothing moved.\n`)));
}

await main();
