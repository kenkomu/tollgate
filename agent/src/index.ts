import {activeChain, formatUsdc, fromUsdc} from "@tollgate/shared";
import type {Address, Hex} from "viem";
import {runAgent} from "./agent.ts";
import {COMPROMISED, NORMAL, type Scenario} from "./scenarios.ts";
import {TollgateClient} from "@tollgate/sdk";
import type {AgentEvent} from "./tools.ts";
import {amber, banner, bold, dim, field, green, grey, meter, red, renderEvent} from "./ui.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(red(`\n  Missing ${name} in .env\n`));
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const scenario: Scenario = process.argv.includes("--compromised") ? COMPROMISED : NORMAL;

  const engine = required("POLICY_ENGINE_ADDRESS") as Address;
  const agentKey = required("AGENT_PRIVATE_KEY") as Hex;
  required("ANTHROPIC_API_KEY");

  const client = new TollgateClient({
    engine,
    agentPrivateKey: agentKey,
    rpcUrl: process.env.ARC_RPC_URL,
  });

  const owner = await client.owner();
  if (owner === "0x0000000000000000000000000000000000000000") {
    console.error(red(`\n  This agent key has no policy bound to it on ${engine}.`));
    console.error(grey(`  Run: forge script script/SeedDemo.s.sol:SeedDemo --broadcast\n`));
    process.exit(1);
  }

  const policy = await client.getPolicy(owner);
  const available = await client.availableNow(owner);
  const gas = await client.gasBalance();

  banner(scenario.title, scenario.subtitle);

  field("chain", `${activeChain.name} (${activeChain.id})`);
  field("policy engine", dim(engine));
  field("owner", dim(owner));
  field("agent key", dim(client.agentAddress));
  field("agent gas", `${(Number(gas) / 1e18).toFixed(4)} USDC ${grey("(its own, not the budget)")}`);
  console.log("");
  console.log(`  ${meter("budget used", policy.spent, policy.budgetCap)}`);
  console.log(`  ${meter("rate headroom", available, policy.bucketCapacity)}`);
  field("per-payment cap", formatUsdc(policy.perTxCap));
  field("status", policy.paused ? red("PAUSED by owner") : green("active"));
  console.log("");
  console.log(amber("  ─── run ───"));
  console.log("");

  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => {
    events.push(event);
    renderEvent(event);
  };

  const summary = await runAgent({
    client,
    owner,
    prompt: scenario.prompt,
    systemPrompt: scenario.systemPrompt,
    emit,
  });

  const after = await client.getPolicy(owner);
  const paid = events.filter((e) => e.kind === "paid");
  const refused = events.filter((e) => e.kind === "refused");
  const moved = paid.reduce((sum, e) => sum + (e.kind === "paid" ? e.amount : 0n), 0n);

  console.log("");
  console.log(amber("  ─── outcome ───"));
  console.log("");
  field("payments made", `${paid.length}`);
  field("payments refused", refused.length > 0 ? red(`${refused.length}`) : "0");
  field("total moved", bold(formatUsdc(moved)));
  field("lifetime spend", `${fromUsdc(after.spent)} / ${fromUsdc(after.budgetCap)} USDC`);

  if (refused.length > 0) {
    console.log("");
    console.log(`  ${grey("refused by:")}`);
    const byReason = new Map<string, number>();
    for (const e of refused) {
      if (e.kind !== "refused") continue;
      const key = String(e.reason);
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) {
      const sample = refused.find((e) => e.kind === "refused" && String(e.reason) === reason);
      if (sample?.kind === "refused") {
        console.log(`    ${red("✕")} ${red(sample.message)} ${grey(`×${count}`)}`);
      }
    }
  }

  if (summary.trim()) {
    console.log("");
    console.log(`  ${grey("agent's own account:")}`);
    for (const line of summary.trim().split("\n")) {
      console.log(`  ${dim("│")} ${line}`);
    }
  }

  console.log("");
  if (scenario.id === "compromised") {
    console.log(
      `  ${green("The key was fully compromised and the policy still held.")}`,
    );
    console.log(
      `  ${grey("Nothing in the agent stopped it. The contract did.")}`,
    );
  }
  console.log("");
}

main().catch((error: unknown) => {
  console.error(red(`\n  ${error instanceof Error ? error.message : String(error)}\n`));
  process.exit(1);
});
