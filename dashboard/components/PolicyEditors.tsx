"use client";

import {useState} from "react";
import {fromUsdc, usdc, type Policy} from "@tollgate/shared";
import {isAddress, type Address} from "viem";
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

const DAY = 86_400n;

/** Guards a text field before it becomes a transaction. */
function parseUsdc(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  try {
    return usdc(trimmed);
  } catch {
    return null;
  }
}

export function CapsEditor({policy}: {policy: Policy}) {
  const [budget, setBudget] = useState(fromUsdc(policy.budgetCap));
  const [perTx, setPerTx] = useState(fromUsdc(policy.perTxCap));

  const parsedBudget = parseUsdc(budget);
  const parsedPerTx = parseUsdc(perTx);
  const valid = parsedBudget !== null && parsedPerTx !== null;
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
      action={() => setCaps(parsedBudget!, parsedPerTx!)}
    >
      <Field
        label="Lifetime budget (USDC)"
        value={budget}
        inputMode="decimal"
        onChange={(e) => setBudget(e.target.value)}
        hint={parsedBudget === null ? "Needs a number, up to six decimals" : undefined}
      />
      <Field
        label="Per payment (USDC)"
        value={perTx}
        inputMode="decimal"
        onChange={(e) => setPerTx(e.target.value)}
        hint={parsedPerTx === null ? "Needs a number, up to six decimals" : undefined}
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
  const valid = parsedBurst !== null && parsedPerDay !== null;
  const dirty = burst !== fromUsdc(policy.bucketCapacity) || perDay !== currentPerDay;

  const realised = parsedPerDay === null ? null : (parsedPerDay / DAY) * DAY;

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
      action={() => setVelocity(parsedBurst!, parsedPerDay! / DAY)}
    >
      <Field
        label="Burst (USDC)"
        value={burst}
        inputMode="decimal"
        onChange={(e) => setBurst(e.target.value)}
      />
      <Field
        label="Refill per day (USDC)"
        value={perDay}
        inputMode="decimal"
        onChange={(e) => setPerDay(e.target.value)}
        hint={
          realised !== null && realised !== parsedPerDay
            ? `Stored per-second, so the realised rate is ${fromUsdc(realised)} a day — rounded down, never up.`
            : undefined
        }
      />
    </EditCard>
  );
}

export function ExpiryEditor({policy}: {policy: Policy}) {
  const current =
    policy.expiry === 0n ? "" : new Date(Number(policy.expiry) * 1000).toISOString().slice(0, 16);
  const [when, setWhen] = useState(current);

  const parsed = when === "" ? 0n : BigInt(Math.floor(new Date(when).getTime() / 1000));
  const valid = when === "" || !Number.isNaN(new Date(when).getTime());

  return (
    <EditCard
      title="Expiry"
      note="After this moment the agent is refused everything. Leave it empty for no expiry — a dead man's switch is only useful if someone would notice it firing."
      dirty={when !== current && valid}
      action={() => setExpiry(parsed)}
    >
      <Field
        label="Expires at"
        type="datetime-local"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        hint={when === "" ? "Empty means never" : undefined}
      />
    </EditCard>
  );
}

export function AgentEditor({policy}: {policy: Policy}) {
  const [next, setNext] = useState("");
  const valid = isAddress(next, {strict: false});

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
      action={() => setAgent(next as Address)}
    >
      <Field
        label="New agent address"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        placeholder="0x…"
        autoComplete="off"
        hint={next !== "" && !valid ? "Not a valid address" : undefined}
      />
    </EditCard>
  );
}

export function AllowanceEditor({allowance, budgetCap}: {allowance: bigint; budgetCap: bigint}) {
  const [amount, setAmount] = useState(fromUsdc(allowance));
  const parsed = parseUsdc(amount);
  const dirty = amount !== fromUsdc(allowance) && parsed !== null;

  return (
    <EditCard
      title="Allowance"
      note={
        <>
          What the contract is permitted to pull from your wallet. This is the second
          ceiling and the real exit: setting it to 0 stops every payment without touching
          the policy. Caps mean nothing above it — a $20 budget behind a $5 allowance
          refuses at $5.
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
        hint={
          parsed !== null && parsed < budgetCap
            ? `Below the ${fromUsdc(budgetCap)} budget — the allowance is what will bind first.`
            : undefined
        }
      />
    </EditCard>
  );
}

export function AddPayeeEditor() {
  const [payee, setPayee] = useState("");
  const valid = isAddress(payee, {strict: false});

  return (
    <EditCard
      title="Add a payee"
      note="Allowlist an address directly, without waiting for the agent to ask for it."
      submitLabel="Allowlist"
      dirty={valid}
      action={() => addPayee(payee as Address)}
    >
      <Field
        label="Address"
        value={payee}
        onChange={(e) => setPayee(e.target.value)}
        placeholder="0x…"
        autoComplete="off"
        hint={payee !== "" && !valid ? "Not a valid address" : undefined}
      />
    </EditCard>
  );
}

export function RevokeEditor() {
  return (
    <EditCard
      title="Delete this policy"
      note={
        <>
          Removes the policy and unbinds the agent. It does <strong>not</strong> touch your
          allowance — that is yours to revoke, and doing it yourself is the whole point of a
          system that never holds your money. Set the allowance to 0 above as well if you
          want the agent fully cut off.
        </>
      }
      submitLabel="Delete policy"
      danger
      confirm="delete"
      action={revokePolicy}
    />
  );
}
