import {
  GasExhaustedError,
  PaymentInFlightError,
  PaymentRevertedError,
  PolicyRefusedError,
  VelocityWaitTooLongError,
} from "./client.ts";

/**
 * Turn a submission failure into an instruction.
 *
 * A model handed a raw stack trace will do the reasonable-looking thing and try again.
 * For an unresolved payment that is the one genuinely harmful move, so the unknown case
 * says so in the first line and hands back the transaction hash to resolve instead.
 */
export function explainSubmissionFailure(error: unknown): string {
  if (error instanceof GasExhaustedError) {
    return (
      `CANNOT SUBMIT — the agent key is out of gas.\n` +
      `${error.message}\n` +
      `This is not a spending limit. Nothing you do with amounts or payees will fix it; ` +
      `report it to the owner and stop trying to pay for things.`
    );
  }
  if (error instanceof VelocityWaitTooLongError) {
    return (
      `Rate limit — nothing was submitted, and nothing was spent.\n` +
      `${error.message}\n` +
      `This one is genuinely retryable, unlike most refusals. Do other work and come back.`
    );
  }
  if (error instanceof PolicyRefusedError) {
    return (
      `${error.message}\n` +
      `This refusal is on chain: ${error.explorerUrl}\n` +
      (error.retryable
        ? `This one can succeed later — wait and try again.`
        : `Retrying will not help. Only the owner can change this.`)
    );
  }
  if (error instanceof PaymentInFlightError) {
    return (
      `PAYMENT STATUS UNKNOWN. Do NOT retry this payment.\n` +
      `It was submitted and had not confirmed when we stopped waiting, so it may still ` +
      `settle. Retrying now is how the same invoice gets paid twice.\n` +
      `Transaction: ${error.explorerUrl}\n` +
      `Report this to the owner as unresolved and move on. Do not re-attempt it.`
    );
  }
  if (error instanceof PaymentRevertedError) {
    return (
      `Payment failed on chain. Nothing was spent.\n` +
      `The policy allowed it when checked, then changed before it executed — the owner ` +
      `likely paused the agent or altered the policy in between.\n` +
      `Transaction: ${error.explorerUrl}\n` +
      `Re-check with check_budget before considering this again.`
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Payment could not be submitted. Nothing was spent.\n${detail}`;
}
