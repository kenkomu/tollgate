import {formatUnits, parseUnits} from "viem";
import {USDC_DECIMALS} from "./chain.ts";

/**
 * USDC amount helpers.
 *
 * Every amount crossing a Tollgate boundary is 6-decimal ERC-20 units, held as bigint.
 * These exist so no caller has to remember that — and so nobody reaches for `parseEther`
 * out of habit and quietly introduces a 10^12 error into something that moves money.
 */

/** "12.50" -> 12500000n */
export function usdc(amount: string | number): bigint {
  return parseUnits(String(amount), USDC_DECIMALS);
}

/** 12500000n -> "12.5" */
export function fromUsdc(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

/** 12500000n -> "$12.50" — for display only, never for arithmetic. */
export function formatUsdc(amount: bigint): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(formatUnits(amount, USDC_DECIMALS)));
}

/**
 * Convert a human rate like "100 USDC per day" into the contract's refillPerSecond.
 *
 * Integer division truncates, so the realised rate is very slightly below the requested
 * one. That is the safe direction: policy should never refill faster than the owner
 * asked for. `refillRateFor("100", "day")` loses under a millionth of a cent per second.
 */
export function refillRateFor(amountPerPeriod: string | number, period: "hour" | "day" | "week"): bigint {
  const seconds = {hour: 3600n, day: 86400n, week: 604800n}[period];
  return usdc(amountPerPeriod) / seconds;
}

/** Inverse of refillRateFor, for rendering a stored rate back to the owner. */
export function ratePerDay(refillPerSecond: bigint): string {
  return fromUsdc(refillPerSecond * 86400n);
}

/**
 * How long until the token bucket holds at least `target`.
 * Returns 0 if it already does, or null if it never will (rate is zero, or the
 * target exceeds the bucket's capacity).
 */
export function secondsUntilAvailable(
  available: bigint,
  target: bigint,
  refillPerSecond: bigint,
  capacity: bigint,
): number | null {
  if (available >= target) return 0;
  if (target > capacity) return null;
  if (refillPerSecond === 0n) return null;
  const deficit = target - available;
  return Number((deficit + refillPerSecond - 1n) / refillPerSecond); // round up
}
