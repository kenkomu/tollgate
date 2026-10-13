import {fromUsdc, usdc} from "@tollgate/shared";
import {isAddress, type Address} from "viem";

/**
 * The rules a policy form checks before it asks for a signature.
 *
 * The contract is the authority and accepts anything type-correct, which leaves room for
 * mistakes it cannot see: a refill so small it rounds to nothing per second, an agent key
 * that is the owner's own wallet, an expiry that has already passed. Each of these signs
 * cleanly, costs gas, and leaves the owner with a policy that does something other than
 * what they typed. They are caught here, in one place, so every form agrees on them.
 *
 * Problems come in two strengths. An `error` blocks the submit because the result is
 * never what anyone means. A `warning` is shown but allowed, because there is a reasonable
 * owner who wants exactly that.
 */

export const DAY = 86_400n;

/** Every amount the contract stores is a uint128. */
export const MAX_UINT128 = (1n << 128n) - 1n;

/** The smallest daily refill that survives the per-second division: 86,400 base units. */
export const MIN_REFILL_PER_DAY = DAY;

export type Check = {level: "error" | "warning"; message: string} | null;

/** A USDC amount typed by a person, or null when it is not one. */
export function parseUsdc(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  try {
    const amount = usdc(trimmed);
    return amount > MAX_UINT128 ? null : amount;
  } catch {
    return null;
  }
}

/** "$X a day" to the contract's per-second rate. Truncates, so the policy never refills faster than asked. */
export function refillPerSecond(perDay: bigint): bigint {
  return perDay / DAY;
}

/** What a daily rate becomes after the round trip through per-second storage. */
export function realisedPerDay(perDay: bigint): bigint {
  return refillPerSecond(perDay) * DAY;
}

export function checkAmount(value: string): Check {
  return parseUsdc(value) === null ? {level: "error", message: "Needs a number, up to six decimals"} : null;
}

export function checkRefill(perDay: bigint | null): Check {
  if (perDay === null) return {level: "error", message: "Needs a number, up to six decimals"};
  if (perDay === 0n) {
    return {level: "warning", message: "Zero means the burst never comes back: once spent, the agent is done."};
  }
  if (perDay < MIN_REFILL_PER_DAY) {
    return {
      level: "error",
      message: `Too small to store: the contract keeps a per-second rate, and anything under ${fromUsdc(MIN_REFILL_PER_DAY)} a day rounds to zero.`,
    };
  }
  const realised = realisedPerDay(perDay);
  if (realised !== perDay) {
    return {
      level: "warning",
      message: `Stored per-second, so the realised rate is ${fromUsdc(realised)} a day, rounded down, never up.`,
    };
  }
  return null;
}

export function checkCaps(budget: bigint | null, perTx: bigint | null, spent = 0n): Check {
  if (budget === null || perTx === null) return null;
  if (budget < spent) {
    return {
      level: "error",
      message: `Below the ${fromUsdc(spent)} USDC already spent. The contract refuses this, because spending must never exceed the cap.`,
    };
  }
  if (budget === 0n) return {level: "warning", message: "A zero budget refuses every payment."};
  if (perTx === 0n) return {level: "warning", message: "A zero per-payment cap refuses every payment."};
  if (perTx > budget) {
    return {level: "warning", message: "Larger than the whole budget, so the budget is what will bind."};
  }
  return null;
}

/** The agent key: present, an address, and not the owner's own wallet. */
export function checkAgent(value: string, owner: Address | null | undefined, current?: Address): Check {
  if (value === "") return null;
  if (!isAddress(value, {strict: false})) return {level: "error", message: "Not a valid address"};
  if (/^0x0{40}$/i.test(value)) return {level: "error", message: "That address is empty."};
  if (owner && value.toLowerCase() === owner.toLowerCase()) {
    return {
      level: "error",
      message: "That is your own wallet. The agent needs a key of its own, or a leaked agent key is a leaked owner key.",
    };
  }
  if (current && value.toLowerCase() === current.toLowerCase()) {
    return {level: "error", message: "That is the key already bound. Rotating to it changes nothing."};
  }
  return null;
}

/** A payee: an address, not empty, and not the policy contract (which can never send on what it receives). */
export function checkPayee(value: string, engine: Address | null | undefined): Check {
  if (value === "") return null;
  if (!isAddress(value, {strict: false})) return {level: "error", message: "Not a valid address"};
  if (/^0x0{40}$/i.test(value)) return {level: "error", message: "That address is empty."};
  if (engine && value.toLowerCase() === engine.toLowerCase()) {
    return {level: "error", message: "That is the policy contract. It cannot pay anything out, so paying it destroys the funds."};
  }
  return null;
}

/** A datetime-local value to unix seconds, or null when it does not parse. Empty means never (0). */
export function parseExpiry(value: string): bigint | null {
  if (value === "") return 0n;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : BigInt(Math.floor(ms / 1000));
}

export function checkExpiry(value: string, now = Date.now()): Check {
  const parsed = parseExpiry(value);
  if (parsed === null) return {level: "error", message: "Not a date"};
  if (parsed !== 0n && parsed * 1000n <= BigInt(now)) {
    return {level: "warning", message: "Already in the past: saving this stops the agent immediately."};
  }
  return null;
}

/**
 * The allowance against what the agents can still spend. `budgetCap - spent` for one policy;
 * for a fleet, pass the sum of every policy's remaining budget as `budgetCap` and 0 as `spent`.
 */
export function checkAllowance(amount: bigint | null, budgetCap: bigint, spent: bigint): Check {
  if (amount === null) return {level: "error", message: "Needs a number, up to six decimals"};
  const left = budgetCap > spent ? budgetCap - spent : 0n;
  if (amount < left) {
    return {
      level: "warning",
      message: `Below the ${fromUsdc(left)} your agents can still spend, so the allowance is what will bind first.`,
    };
  }
  if (amount > left && left > 0n) {
    return {
      level: "warning",
      message: `More than the ${fromUsdc(left)} your agents can still spend. The extra protects nothing and is exposed if this contract is ever wrong.`,
    };
  }
  return null;
}

/** True when nothing in the list blocks submission. */
export function passes(...checks: Check[]): boolean {
  return checks.every((check) => check?.level !== "error");
}
