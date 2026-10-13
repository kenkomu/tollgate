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

/**
 * Starting points, not recommendations. Each sets all four numbers at once and can be edited
 * before signing. Small on purpose: the first policy someone creates should be one they would
 * be comfortable losing entirely, because that is the most it can ever cost them.
 */
const TEMPLATES = [
  {
    id: "trial",
    name: "Trial run",
    blurb: "Try it out with pocket change",
    budget: "5",
    perTx: "1",
    burst: "2",
    perDay: "5",
  },
  {
    id: "research",
    name: "Research agent",
    blurb: "Many small API and data purchases",
    budget: "25",
    perTx: "0.50",
    burst: "3",
    perDay: "10",
  },
  {
    id: "procurement",
    name: "Procurement agent",
    blurb: "A few larger orders to known suppliers",
    budget: "200",
    perTx: "50",
    burst: "100",
    perDay: "100",
  },
] as const;

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

  const [template, setTemplate] = useState<string | null>(null);

  function apply(id: string) {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setTemplate(id);
    setBudget(t.budget);
    setPerTx(t.perTx);
    setBurst(t.burst);
    setPerDay(t.perDay);
  }

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
      <fieldset className="templates">
        <legend>Start from a template</legend>
        <div className="template-list">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`template${template === t.id ? " active" : ""}`}
              aria-pressed={template === t.id}
              onClick={() => apply(t.id)}
            >
              <span className="template-name">{t.name}</span>
              <span className="template-blurb">{t.blurb}</span>
              <span className="template-numbers">
                ${t.budget} total · ${t.perTx} each · ${t.perDay}/day
              </span>
            </button>
          ))}
        </div>
      </fieldset>
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
