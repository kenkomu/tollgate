"use client";

import {useState} from "react";
import {usdc} from "@tollgate/shared";
import {isAddress, type Address} from "viem";
import {EditCard, Field} from "./EditCard.tsx";
import {createPolicy} from "../lib/owner.ts";

/**
 * Onboarding.
 *
 * This form exists to delete a sentence from the README: "seed one with `forge script
 * script/SeedDemo.s.sol:SeedDemo --broadcast`". Requiring a Foundry install to create a
 * spending limit meant the product was only usable by the person who wrote it.
 *
 * It submits two transactions, and the order is not arbitrary. `approve` runs first, so
 * the policy is never briefly live with no allowance behind it — a state where the
 * dashboard looks perfectly healthy and every payment refuses with INSUFFICIENT_ALLOWANCE.
 * The defaults below are the demo's, which are deliberately small.
 */

const DAY = 86_400n;

function parseUsdc(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  try {
    return usdc(trimmed);
  } catch {
    return null;
  }
}

export function CreatePolicy() {
  const [agent, setAgent] = useState("");
  const [budget, setBudget] = useState("10");
  const [perTx, setPerTx] = useState("2");
  const [burst, setBurst] = useState("4");
  const [perDay, setPerDay] = useState("96");

  const parsed = {
    budget: parseUsdc(budget),
    perTx: parseUsdc(perTx),
    burst: parseUsdc(burst),
    perDay: parseUsdc(perDay),
  };

  const agentValid = isAddress(agent, {strict: false});
  const ready =
    agentValid &&
    parsed.budget !== null &&
    parsed.perTx !== null &&
    parsed.burst !== null &&
    parsed.perDay !== null;

  return (
    <EditCard
      title="Create a policy"
      note={
        <>
          Two transactions: an allowance for exactly the budget, then the policy itself.
          The agent key can only ask to spend — it can never change anything you set here.
        </>
      }
      submitLabel="Approve and create"
      dirty={ready}
      action={() =>
        createPolicy({
          agent: agent as Address,
          budgetCap: parsed.budget!,
          perTxCap: parsed.perTx!,
          bucketCapacity: parsed.burst!,
          refillPerSecond: parsed.perDay! / DAY,
          expiry: 0n,
        })
      }
    >
      <Field
        label="Agent address"
        value={agent}
        onChange={(e) => setAgent(e.target.value)}
        placeholder="0x…"
        autoComplete="off"
        hint={
          agent !== "" && !agentValid
            ? "Not a valid address"
            : "The key your agent signs with. Never your own."
        }
      />
      <Field
        label="Lifetime budget (USDC)"
        value={budget}
        inputMode="decimal"
        onChange={(e) => setBudget(e.target.value)}
        hint="Also the allowance. Approved exactly, never unlimited."
      />
      <Field
        label="Per payment (USDC)"
        value={perTx}
        inputMode="decimal"
        onChange={(e) => setPerTx(e.target.value)}
      />
      <Field
        label="Burst (USDC)"
        value={burst}
        inputMode="decimal"
        onChange={(e) => setBurst(e.target.value)}
        hint="The most that can leave at once."
      />
      <Field
        label="Refill per day (USDC)"
        value={perDay}
        inputMode="decimal"
        onChange={(e) => setPerDay(e.target.value)}
        hint="How fast the burst allowance comes back."
      />
    </EditCard>
  );
}
