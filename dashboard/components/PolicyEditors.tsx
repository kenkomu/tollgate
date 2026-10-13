"use client";

import {useState} from "react";
import {fromUsdc, type PolicyWithId as Policy} from "@tollgate/shared";
import type {Address} from "viem";
import {EditCard, Field} from "./EditCard.tsx";
import {
  addPayee,
  revokePolicy,
  setAgent,
  setAllowance,
  setCaps,
  setExpiry,
  setVelocity,
} from "../lib/owner.ts";
import {ENGINE, OWNER} from "../lib/chain.ts";
import {
  DAY,
  checkAgent,
  checkAllowance,
  checkAmount,
  checkCaps,
  checkExpiry,
  checkPayee,
  checkRefill,
  parseExpiry,
  parseUsdc,
  passes,
  refillPerSecond,
} from "../lib/policy-form.ts";

/**
 * The policy, editable.
 *
 * Two translations happen here and nowhere else, because getting either wrong is a money
 * bug rather than a display bug:
 *
 *   - USDC in, 6-decimal bigint out. Every field goes through `usdc()`; nothing multiplies
 *     by a literal.
 *   - The owner thinks in "$100 a day". The contract stores `refillPerSecond`. `usdc(x) /
 *     86400n` truncates, so the realised rate lands very slightly *under* what was asked
 *     for — the safe direction, since policy should never refill faster than requested.
 */

export function CapsEditor({policy}: {policy: Policy}) {
  const [budget, setBudget] = useState(fromUsdc(policy.budgetCap));
  const [perTx, setPerTx] = useState(fromUsdc(policy.perTxCap));

  const parsedBudget = parseUsdc(budget);
  const parsedPerTx = parseUsdc(perTx);
  const caps = checkCaps(parsedBudget, parsedPerTx, policy.spent);
  const budgetCheck = checkAmount(budget) ?? caps;
  const perTxCheck = checkAmount(perTx);
  const valid = passes(budgetCheck, perTxCheck);
  const dirty = budget !== fromUsdc(policy.budgetCap) || perTx !== fromUsdc(policy.perTxCap);

  return (
    <EditCard
      title="Spending caps"
      note={
        policy.spent > 0n ? (
          <>
            The lifetime ceiling and the most that can leave in one payment. The contract
            refuses a budget below the {fromUsdc(policy.spent)} USDC already spent — that
            would break the guarantee that spending never exceeds the cap.
          </>
        ) : (
          <>The lifetime ceiling, and the most that can leave in any one payment.</>
        )
      }
      dirty={dirty && valid}
      action={() => setCaps(policy.id, parsedBudget!, parsedPerTx!)}
    >
      <Field
        label="Lifetime budget (USDC)"
        value={budget}
        inputMode="decimal"
        onChange={(e) => setBudget(e.target.value)}
        check={budgetCheck}
      />
      <Field
        label="Per payment (USDC)"
        value={perTx}
        inputMode="decimal"
        onChange={(e) => setPerTx(e.target.value)}
        check={perTxCheck}
      />
    </EditCard>
  );
}

export function VelocityEditor({policy}: {policy: Policy}) {
  const currentPerDay = fromUsdc(policy.refillPerSecond * DAY);
  const [burst, setBurst] = useState(fromUsdc(policy.bucketCapacity));
  const [perDay, setPerDay] = useState(currentPerDay);

  const parsedBurst = parseUsdc(burst);
  const parsedPerDay = parseUsdc(perDay);
  const burstCheck = checkAmount(burst);
  const refillCheck = checkRefill(parsedPerDay);
  const valid = passes(burstCheck, refillCheck);
  const dirty = burst !== fromUsdc(policy.bucketCapacity) || perDay !== currentPerDay;

  return (
    <EditCard
      title="Rate limit"
      note={
        <>
          Burst is the most that can leave at once with a full bucket. The daily rate is
          how fast it refills. Together they stop many individually-legal payments from
          draining the budget in a minute.
        </>
      }
      dirty={dirty && valid}
      action={() => setVelocity(policy.id, parsedBurst!, refillPerSecond(parsedPerDay!))}
    >
      <Field
        label="Burst (USDC)"
        value={burst}
        inputMode="decimal"
        onChange={(e) => setBurst(e.target.value)}
        check={burstCheck}
      />
      <Field
        label="Refill per day (USDC)"
        value={perDay}
        inputMode="decimal"
        onChange={(e) => setPerDay(e.target.value)}
        check={refillCheck}
      />
    </EditCard>
  );
}

export function ExpiryEditor({policy}: {policy: Policy}) {
  const current =
    policy.expiry === 0n ? "" : new Date(Number(policy.expiry) * 1000).toISOString().slice(0, 16);
  const [when, setWhen] = useState(current);

  const parsed = parseExpiry(when);
  const check = checkExpiry(when);
  const valid = passes(check);

  return (
    <EditCard
      title="Expiry"
      note="After this moment the agent is refused everything. Leave it empty for no expiry — a dead man's switch is only useful if someone would notice it firing."
      dirty={when !== current && valid}
      action={() => setExpiry(policy.id, parsed!)}
    >
      <Field
        label="Expires at"
        type="datetime-local"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        check={check}
        hint={when === "" ? "Empty means never" : undefined}
      />
    </EditCard>
  );
}

export function AgentEditor({policy}: {policy: Policy}) {
  const [next, setNext] = useState("");
  const check = checkAgent(next, OWNER, policy.agent);
  const valid = next !== "" && passes(check);

  return (
    <EditCard
      title="Rotate the agent key"
      note={
        <>
          Binds a new key and unbinds <code>{policy.agent}</code> in the same transaction.
          This is what to do the moment you suspect the current key has leaked — the old
          one is worthless immediately, without touching your funds.
        </>
      }
      submitLabel="Rotate key"
      dirty={valid}
      action={() => setAgent(policy.id, next as Address)}
    >
      <Field
        label="New agent address"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        placeholder="0x…"
        autoComplete="off"
        check={check}
      />
    </EditCard>
  );
}

export function AllowanceEditor({
  allowance,
  needed,
  agents = 1,
}: {
  allowance: bigint;
  /** What every agent together can still spend: the most the allowance usefully covers. */
  needed: bigint;
  agents?: number;
}) {
  const [amount, setAmount] = useState(fromUsdc(allowance));
  const parsed = parseUsdc(amount);
  const check = checkAllowance(parsed, needed, 0n);
  const dirty = amount !== fromUsdc(allowance) && passes(check);

  return (
    <EditCard
      title="Allowance"
      note={
        <>
          What the contract is permitted to pull from your wallet
          {agents > 1 ? <>, shared by all {agents} of your agents</> : null}. This is the second
          ceiling and the real exit: setting it to 0 stops every payment without touching any
          policy. Caps mean nothing above it: a $20 budget behind a $5 allowance refuses at $5.
        </>
      }
      submitLabel="Set allowance"
      dirty={dirty}
      action={() => setAllowance(parsed!)}
    >
      <Field
        label="Approved amount (USDC)"
        value={amount}
        inputMode="decimal"
        onChange={(e) => setAmount(e.target.value)}
        check={check}
      />
    </EditCard>
  );
}

export function AddPayeeEditor({policyId, name}: {policyId: bigint; name?: string | undefined}) {
  const [payee, setPayee] = useState("");
  const check = checkPayee(payee, ENGINE);
  const valid = payee !== "" && passes(check);

  return (
    <EditCard
      title={name ? `Add a payee for ${name}` : "Add a payee"}
      note={`Allowlist an address directly, without waiting for ${name ?? "the agent"} to ask for it.${name ? " Your other agents are not affected." : ""}`}
      submitLabel="Allowlist"
      dirty={valid}
      action={() => addPayee(policyId, payee as Address)}
    >
      <Field
        label="Address"
        value={payee}
        onChange={(e) => setPayee(e.target.value)}
        placeholder="0x…"
        autoComplete="off"
        check={check}
      />
    </EditCard>
  );
}

export function RevokeEditor({policyId, name}: {policyId: bigint; name?: string | undefined}) {
  return (
    <EditCard
      title={name ? `Delete ${name}'s policy` : "Delete this policy"}
      note={
        <>
          Removes this policy and unbinds its agent key. Your other agents are not affected. It
          does <strong>not</strong> touch your allowance: that is yours to change, and doing it
          yourself is the whole point of a system that never holds your money. Lower the
          allowance above by this agent&rsquo;s remaining budget once it is gone.
        </>
      }
      submitLabel="Delete policy"
      danger
      confirm="delete"
      action={() => revokePolicy(policyId)}
    />
  );
}
