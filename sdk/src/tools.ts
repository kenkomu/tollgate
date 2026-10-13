import {formatUsdc, fromUsdc, usdc} from "@tollgate/shared";
import {isAddress, type Address} from "viem";
import {z} from "zod";
import {PolicyRefusedError, type TollgateClient} from "./client.ts";
import {explainSubmissionFailure} from "./explain.ts";
import {ApprovalInbox} from "./approvals.ts";

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

export interface ToolOptions {
  /** The owner whose policy binds this agent. Looked up from the chain when omitted. */
  owner?: Address;
  /** The Tollgate service, for filing approval requests. Without it the approval tools say so. */
  serviceUrl?: string;
}

export function createTools(client: TollgateClient, options: ToolOptions = {}) {
  const {owner} = options;
  const resolveOwner = async () => owner ?? (await client.owner());
  const inbox = new ApprovalInbox({client, owner, serviceUrl: options.serviceUrl});

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

    tool({
      name: "request_payee_approval",
      description:
        "Ask the human owner to add a payee to the allowlist. The ONLY way past a PAYEE_NOT_ALLOWED " +
        "refusal: you cannot approve it yourself. Returns a request id; check it later with check_approval.",
      shape: {
        address: z.string().describe("The payee you need, 0x-prefixed"),
        amount: z.string().optional().describe('What you intend to pay them, e.g. "2.00"'),
        why: z.string().describe("Why this is worth the owner's attention, in one sentence"),
      },
      async run({address, amount, why}) {
        if (!isAddress(address, {strict: false})) return {ok: false, text: `Not a valid address: ${address}.`};
        const ticket = await inbox.request({payee: address as Address, amount: amount ? `${amount} USDC` : undefined, why});
        if (!ticket) {
          return {
            ok: false,
            text:
              "Could not file the request: no Tollgate service is reachable. Tell the owner directly that you " +
              `need ${address} approved. Do not retry the payment until they confirm.`,
          };
        }
        return {
          ok: true,
          text:
            `Approval requested. Request id: ${ticket.id}\n` +
            "The owner has been notified. They approve by signing on chain, which you cannot do or skip. " +
            "Do other work, then call check_approval with this id. Do not retry the payment before it says approved.",
        };
      },
    }),

    tool({
      name: "check_approval",
      description:
        "Check a payee-approval request. 'approved' is read from the on-chain allowlist, so it is " +
        "safe to pay once this says so.",
      shape: {
        id: z.string().describe("The request id from request_payee_approval"),
        address: z.string().describe("The payee the request was for"),
      },
      async run({id, address}) {
        if (!isAddress(address, {strict: false})) return {ok: false, text: `Not a valid address: ${address}.`};
        const status = await inbox.status({id, payee: address as Address});
        const text = {
          approved: "APPROVED. The payee is on the on-chain allowlist. You may retry the payment.",
          declined: "DECLINED by the owner. Do not pay this address. Find another way or report back.",
          pending: "Still pending. The owner has not acted yet. Keep working on other things and check again later.",
        }[status];
        return {ok: status === "approved", text};
      },
    }),
  ];
}

export type TollgateTools = ReturnType<typeof createTools>;
