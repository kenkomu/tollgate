/**
 * Reason codes.
 *
 * These mirror `PolicyEngine.Reason` in Solidity exactly, by index. The order is part of
 * the ABI — append only, never reorder, never delete.
 *
 * Deliberately a const object rather than a TypeScript `enum`: Node runs this repo's
 * TypeScript directly, in strip-only mode, which rejects `enum` because it emits runtime
 * code rather than being pure type syntax. `erasableSyntaxOnly` in tsconfig makes that a
 * typecheck failure instead of a surprise at runtime.
 */
export const Reason = {
  OK: 0,
  NO_POLICY: 1,
  NOT_AGENT: 2,
  PAUSED: 3,
  EXPIRED: 4,
  PAYEE_NOT_ALLOWED: 5,
  AMOUNT_ZERO: 6,
  EXCEEDS_PER_TX: 7,
  EXCEEDS_BUDGET: 8,
  EXCEEDS_VELOCITY: 9,
  INSUFFICIENT_ALLOWANCE: 10,
  INSUFFICIENT_BALANCE: 11,
} as const;

export type Reason = (typeof Reason)[keyof typeof Reason];

export const REASON_NAMES: Readonly<Record<Reason, string>> = Object.freeze(
  Object.fromEntries(Object.entries(Reason).map(([name, code]) => [code, name])) as Record<Reason, string>,
);

/**
 * Whether waiting could change the answer.
 *
 * This is the distinction an agent actually needs. `retry-later` means the bucket will
 * refill and the same call will eventually work — back off and try again. `needs-owner`
 * means no amount of retrying helps; a human has to act. An agent that retries a
 * `needs-owner` refusal in a loop is the exact failure this product exists to contain.
 */
export type ReasonKind = "ok" | "retry-later" | "needs-owner" | "bad-request";

export interface ReasonInfo {
  /** Shown to the owner in the audit log. Plain English, no jargon. */
  readonly owner: string;
  /** Returned to the agent. Says what to do, not just what happened. */
  readonly agent: string;
  readonly kind: ReasonKind;
}

export const REASONS: Readonly<Record<Reason, ReasonInfo>> = {
  [Reason.OK]: {
    owner: "Allowed",
    agent: "Permitted.",
    kind: "ok",
  },
  [Reason.NO_POLICY]: {
    owner: "This agent has no policy",
    agent: "No policy is bound to this key. Ask the owner to create one.",
    kind: "needs-owner",
  },
  [Reason.NOT_AGENT]: {
    owner: "Signed by the wrong key",
    agent: "This key is not the agent registered on the policy.",
    kind: "needs-owner",
  },
  [Reason.PAUSED]: {
    owner: "You paused this agent",
    agent: "Spending is paused by the owner. Do not retry until it is resumed.",
    kind: "needs-owner",
  },
  [Reason.EXPIRED]: {
    owner: "The agent's access has expired",
    agent: "This session key has expired. Ask the owner to extend or rotate it.",
    kind: "needs-owner",
  },
  [Reason.PAYEE_NOT_ALLOWED]: {
    owner: "Payee is not on your allowlist",
    agent: "This recipient is not approved. Ask the owner to add it before retrying.",
    kind: "needs-owner",
  },
  [Reason.AMOUNT_ZERO]: {
    owner: "Nothing to send",
    agent: "Amount was zero.",
    kind: "bad-request",
  },
  [Reason.EXCEEDS_PER_TX]: {
    owner: "Single payment above your per-payment limit",
    agent: "Above the per-transaction cap. Split it or ask the owner to raise the cap.",
    kind: "needs-owner",
  },
  [Reason.EXCEEDS_BUDGET]: {
    owner: "Would exceed the total budget",
    agent: "The lifetime budget is exhausted. Only the owner can raise it.",
    kind: "needs-owner",
  },
  [Reason.EXCEEDS_VELOCITY]: {
    owner: "Spending too fast",
    agent: "Rate limit reached. The allowance refills over time — back off and retry.",
    kind: "retry-later",
  },
  [Reason.INSUFFICIENT_ALLOWANCE]: {
    owner: "Your approved amount has run out",
    agent: "The owner's approval is exhausted. Only the owner can top it up.",
    kind: "needs-owner",
  },
  [Reason.INSUFFICIENT_BALANCE]: {
    owner: "Not enough USDC in your wallet",
    agent: "The owner's wallet cannot cover this. Only the owner can fund it.",
    kind: "needs-owner",
  },
} as const;

export function reasonName(reason: Reason): string {
  return REASON_NAMES[reason] ?? `UNKNOWN_${reason}`;
}

/** Owner-facing text for the audit log. */
export function explainToOwner(reason: Reason): string {
  return REASONS[reason]?.owner ?? `Refused (code ${reason})`;
}

/** Agent-facing text, returned by the SDK so the agent knows whether to retry. */
export function explainToAgent(reason: Reason): string {
  return REASONS[reason]?.agent ?? `Refused (code ${reason}).`;
}

export function reasonKind(reason: Reason): ReasonKind {
  return REASONS[reason]?.kind ?? "needs-owner";
}

/** True when backing off and retrying the identical call could succeed. */
export function isRetryable(reason: Reason): boolean {
  return reasonKind(reason) === "retry-later";
}

export function isAllowed(reason: Reason): boolean {
  return reason === Reason.OK;
}
