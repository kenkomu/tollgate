import {formatUsdc, fromUsdc, usdc} from "@tollgate/shared";
import {isAddress, type Address} from "viem";
import {z} from "zod";
import {PolicyRefusedError, type TollgateClient} from "./client.ts";
import {explainSubmissionFailure} from "./explain.ts";

/**
 * Framework-neutral tool definitions.
 *
 * One definition feeds every adapter (MCP server, Glove, anything else with a name, a
 * description, a Zod schema and an async function), so the wording an agent sees about
 * refusals and unknown payments is identical everywhere. That wording is load-bearing:
 * "PAYMENT STATUS UNKNOWN, do not retry" is the sentence that stops a double payment.
 *
 * Note what is NOT here: any check on what the agent may do. `pay` accepts any address and
 * any amount. Narrowing the tool would be an app-level guardrail, which is what this
 * product exists to replace. The contract decides.
 */

export interface ToolResult {
  /** False for anything that did not result in a completed action the agent asked for. */
  ok: boolean;
  /** What the agent reads. Plain text, written as an instruction. */
  text: string;
}

export interface TollgateTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: Shape;
  run(input: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

function tool<Shape extends z.ZodRawShape>(def: TollgateTool<Shape>): TollgateTool<Shape> {
  return def;
}

const parseAmount = (amount: string): bigint | null => {
  try {
    return usdc(amount);
  } catch {
    return null;
  }
};

export function createTools(client: TollgateClient, owner?: Address) {
  const resolveOwner = async () => owner ?? (await client.owner());

  return [
    tool({
      name: "check_payment",
      description:
        "Ask Tollgate whether a payment would be permitted, WITHOUT spending anything. Costs " +
        "no gas and changes nothing. Returns a reason code and whether waiting would help.",
      shape: {
        address: z.string().describe("Recipient address, 0x-prefixed"),
        amount: z.string().describe('Amount in USDC, e.g. "1.50"'),
      },
      async run({address, amount}) {
        if (!isAddress(address, {strict: false})) return {ok: false, text: `Not a valid address: ${address}.`};
        const value = parseAmount(amount);
        if (value === null) return {ok: false, text: `Could not parse amount: ${amount}`};

        const result = await client.check(address as Address, value);
        return {
          ok: result.allowed,
          text: [
            `Permitted: ${result.allowed ? "yes" : "no"}`,
            `Reason: ${result.reasonName} (${result.reason})`,
            `Guidance: ${result.message}`,
            `Retrying could help: ${result.retryable ? "yes, after waiting" : "no"}`,
          ].join("\n"),
        };
      },
    }),

    tool({
      name: "pay",
      description:
        "Send USDC to any address, for any amount. Unrestricted at the tool level: the Tollgate " +
        "policy contract decides whether it happens. If it refuses, nothing moves and you get " +
        "the reason back.",
      shape: {
        address: z.string().describe("Recipient address, 0x-prefixed"),
        amount: z.string().describe('Amount in USDC, e.g. "1.50"'),
      },
      async run({address, amount}) {
        // A malformed address is the agent's mistake, not a policy refusal; conflating the two
        // would muddy the owner's audit log.
        if (!isAddress(address, {strict: false})) {
          return {ok: false, text: `Not a valid address: ${address}. Addresses are 0x followed by 40 hex characters.`};
        }
        const value = parseAmount(amount);
        if (value === null) return {ok: false, text: `Could not parse amount: ${amount}`};

        try {
          const receipt = await client.spend(address as Address, value);
          return {
            ok: true,
            text: `Sent ${formatUsdc(value)} to ${address}.\nTransaction: ${receipt.explorerUrl}`,
          };
        } catch (error) {
          const hint =
            error instanceof PolicyRefusedError && error.reasonName === "PAYEE_NOT_ALLOWED"
              ? "\nThis payee is not on the owner's allowlist. Ask the owner to approve it."
              : "";
          return {ok: false, text: explainSubmissionFailure(error) + hint};
        }
      },
    }),

    tool({
      name: "get_budget",
      description:
        "How much this agent may still spend: remaining lifetime budget and rate-limit headroom right now.",
      shape: {},
      async run() {
        const who = await resolveOwner();
        const [available, budget] = await Promise.all([client.availableNow(who), client.remainingBudget(who)]);
        return {
          ok: true,
          text:
            `Rate-limit headroom right now: ${fromUsdc(available)} USDC\n` +
            `Remaining lifetime budget: ${fromUsdc(budget)} USDC`,
        };
      },
    }),

    tool({
      name: "check_gas",
      description:
        "Check whether the agent's own key can still pay transaction fees. This is separate from " +
        "the owner's spending budget: running out stops everything and is not a policy refusal.",
      shape: {},
      async run() {
        const health = await client.gasHealth();
        return {
          ok: !health.empty,
          text: [
            `Agent gas balance: ${fromUsdc(health.balance / 1_000_000_000_000n)} USDC (approx)`,
            `Payments this affords: about ${health.paymentsLeft}`,
            health.empty
              ? `EMPTY. You cannot submit anything. Tell the owner to fund the agent key.`
              : health.low
                ? `LOW. Still working, but tell the owner before it runs out mid-task.`
                : `Healthy.`,
          ].join("\n"),
        };
      },
    }),

    tool({
      name: "resolve_payment",
      description:
        "Resolve a payment whose outcome is UNKNOWN (one that reported PAYMENT STATUS UNKNOWN). " +
        "Reads the chain and, if genuinely stuck, replaces it at the same nonce so it lands or is " +
        "cancelled. Never creates a second payment.",
      shape: {
        txHash: z.string().describe("The transaction hash from the unknown-status report"),
        mode: z.enum(["speed-up", "cancel"]).describe("speed-up if the payment should still happen, cancel if not"),
      },
      async run({txHash, mode}) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return {ok: false, text: `Not a transaction hash: ${txHash}`};
        try {
          const outcome = await client.unstick(txHash as `0x${string}`, mode);
          if (outcome.outcome === "already-settled") {
            return {
              ok: outcome.succeeded,
              text: outcome.succeeded
                ? `Resolved: that payment DID settle. It is done. Do not send it again.`
                : `Resolved: that transaction was mined and failed. Nothing moved. Safe to reassess.`,
            };
          }
          return {
            ok: true,
            text:
              `Replaced at the same nonce, so there is still only one payment.\n` +
              `${mode === "cancel" ? "Cancelled" : "Resubmitted at a higher fee"}: ${outcome.explorerUrl}`,
          };
        } catch (error) {
          return {ok: false, text: explainSubmissionFailure(error)};
        }
      },
    }),
  ];
}

export type TollgateTools = ReturnType<typeof createTools>;
