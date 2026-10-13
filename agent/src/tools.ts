import {formatUsdc, fromUsdc, Reason, usdc} from "@tollgate/shared";
import {tool} from "@anthropic-ai/claude-agent-sdk";
import {z} from "zod";
import {isAddress, type Address} from "viem";
import {explainSubmissionFailure, PolicyRefusedError, type TollgateClient} from "@tollgate/sdk";
import {fileRequest} from "./approvals.ts";
import {SERVICES, findService} from "./marketplace.ts";

/**
 * The tools the agent is given.
 *
 * One choice here is deliberate and load-bearing: `pay_address` takes an arbitrary
 * address and an arbitrary amount. We do NOT constrain the agent by giving it a narrow
 * tool surface, because that would be exactly the app-level guardrail this product exists
 * to replace — a compromised or prompt-injected agent simply ignores it.
 *
 * The agent is handed the rawest possible capability and stopped by the contract instead.
 * If the demo only worked because the tools were restrictive, it would prove nothing.
 */

export type AgentEvent =
  | {kind: "thinking"; text: string}
  | {kind: "listed"; count: number}
  | {kind: "checked"; label: string; amount: bigint; reason: Reason; allowed: boolean; message: string}
  | {kind: "paid"; label: string; amount: bigint; txHash: string; explorerUrl: string}
  | {
      kind: "refused";
      label: string;
      amount: bigint;
      reason: Reason;
      message: string;
      /** Present now that refusals settle on chain rather than dying in a pre-check. */
      txHash?: string;
      explorerUrl?: string;
    }
  | {kind: "escalated"; label: string; payee: Address; why: string};

export type EventSink = (event: AgentEvent) => void;

function text(body: string) {
  return {content: [{type: "text" as const, text: body}]};
}

export function createTollgateTools(client: TollgateClient, owner: Address, emit: EventSink) {
  const listServices = tool(
    "list_services",
    "List the paid services available to buy, with prices in USDC and the address each pays.",
    {},
    async () => {
      emit({kind: "listed", count: SERVICES.length});
      const rows = SERVICES.map(
        (s) => `- ${s.id} — ${s.name}, ${formatUsdc(s.price)} → ${s.payee}\n  ${s.description}`,
      ).join("\n");
      return text(`Available services:\n${rows}`);
    },
  );

  const checkBudget = tool(
    "check_budget",
    "Ask Tollgate whether a payment would be permitted, WITHOUT spending anything. " +
      "Costs no gas and changes nothing. Always call this before pay_service. " +
      "Returns a reason code and whether waiting would help.",
    {
      serviceId: z.string().describe("The service id from list_services"),
    },
    async ({serviceId}) => {
      const service = findService(serviceId);
      if (!service) return text(`No such service: ${serviceId}`);

      const result = await client.check(service.payee, service.price);
      emit({
        kind: "checked",
        label: service.name,
        amount: service.price,
        reason: result.reason,
        allowed: result.allowed,
        message: result.message,
      });

      const available = await client.availableNow(owner);
      const budget = await client.remainingBudget(owner);

      return text(
        [
          `${service.name} — ${formatUsdc(service.price)}`,
          `Permitted: ${result.allowed ? "yes" : "no"}`,
          `Reason: ${result.reasonName} (${result.reason})`,
          `Guidance: ${result.message}`,
          `Retrying could help: ${result.retryable ? "yes, after waiting" : "no"}`,
          `Rate-limit headroom right now: ${fromUsdc(available)} USDC`,
          `Remaining lifetime budget: ${fromUsdc(budget)} USDC`,
        ].join("\n"),
      );
    },
  );

  const payService = tool(
    "pay_service",
    "Pay for a service through Tollgate. The policy contract decides; if it refuses, " +
      "nothing moves and you get the reason back.",
    {
      serviceId: z.string().describe("The service id from list_services"),
    },
    async ({serviceId}) => {
      const service = findService(serviceId);
      if (!service) return text(`No such service: ${serviceId}`);

      // No bail on a failed pre-check. The attempt is submitted either way, so that a
      // refusal lands in the owner's audit log instead of vanishing into this process's
      // stdout. `check_budget` remains available for free planning; this is the moment of
      // committing, and committing is what gets recorded.
      let receipt;
      try {
        receipt = await client.spend(service.payee, service.price);
      } catch (error) {
        if (error instanceof PolicyRefusedError) {
          emit({
            kind: "refused",
            label: service.name,
            amount: service.price,
            reason: error.reason,
            message: error.message,
            txHash: error.txHash,
            explorerUrl: error.explorerUrl,
          });
          return text(
            explainSubmissionFailure(error) +
              (error.reason === Reason.PAYEE_NOT_ALLOWED
                ? `\nThis payee is not on the owner's allowlist. Use request_payee_approval.`
                : ""),
          );
        }
        return text(explainSubmissionFailure(error));
      }

      emit({
        kind: "paid",
        label: service.name,
        amount: service.price,
        txHash: receipt.txHash,
        explorerUrl: receipt.explorerUrl,
      });
      return text(
        `Paid ${formatUsdc(service.price)} for ${service.name}.\n` +
          `Transaction: ${receipt.explorerUrl}\n` +
          `Lifetime spend now ${fromUsdc(receipt.spentTotal)} USDC.`,
      );
    },
  );

  const payAddress = tool(
    "pay_address",
    "Send USDC to any address, for any amount. Unrestricted at the tool level — " +
      "the Tollgate policy contract is what decides whether it actually happens.",
    {
      address: z.string().describe("Recipient address, 0x-prefixed"),
      amount: z.string().describe("Amount in USDC, e.g. \"1.50\""),
    },
    async ({address, amount}) => {
      // Validate here rather than letting viem throw. A malformed address is the agent's
      // mistake, not a policy refusal, and conflating the two would muddy the audit log.
      if (!isAddress(address, {strict: false})) {
        return text(`Not a valid address: ${address}. Addresses are 0x followed by 40 hex characters.`);
      }
      const payee = address as Address;
      let value: bigint;
      try {
        value = usdc(amount);
      } catch {
        return text(`Could not parse amount: ${amount}`);
      }

      let receipt;
      try {
        receipt = await client.spend(payee, value);
      } catch (error) {
        if (error instanceof PolicyRefusedError) {
          emit({
            kind: "refused",
            label: `direct → ${payee}`,
            amount: value,
            reason: error.reason,
            message: error.message,
            txHash: error.txHash,
            explorerUrl: error.explorerUrl,
          });
        }
        return text(explainSubmissionFailure(error));
      }

      emit({
        kind: "paid",
        label: `direct → ${payee}`,
        amount: value,
        txHash: receipt.txHash,
        explorerUrl: receipt.explorerUrl,
      });
      return text(`Sent ${formatUsdc(value)} to ${payee}.\nTransaction: ${receipt.explorerUrl}`);
    },
  );

  const resolvePayment = tool(
    "resolve_payment",
    "Resolve a payment whose outcome is UNKNOWN — one that reported PAYMENT STATUS " +
      "UNKNOWN. Reads the chain and, if it is genuinely stuck, replaces it at the same " +
      "nonce so it either lands or is cancelled. Never creates a second payment.",
    {
      txHash: z.string().describe("The transaction hash from the unknown-status report"),
      mode: z
        .enum(["speed-up", "cancel"])
        .describe("speed-up if the payment should still happen, cancel if it should not"),
    },
    async ({txHash, mode}) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return text(`Not a transaction hash: ${txHash}`);
      try {
        const outcome = await client.unstick(txHash as `0x${string}`, mode);
        if (outcome.outcome === "already-settled") {
          return text(
            outcome.succeeded
              ? `Resolved: that payment DID settle. It is done — do not send it again.`
              : `Resolved: that transaction was mined and failed. Nothing moved. Safe to reassess.`,
          );
        }
        return text(
          `Replaced at the same nonce, so there is still only one payment.\n` +
            `${mode === "cancel" ? "Cancelled" : "Resubmitted at a higher fee"}: ${outcome.explorerUrl}`,
        );
      } catch (error) {
        return text(explainSubmissionFailure(error));
      }
    },
  );

  const checkGas = tool(
    "check_gas",
    "Check whether the agent's own key can still pay transaction fees. This is separate " +
      "from the owner's spending budget — running out stops everything and is not a " +
      "policy refusal.",
    {},
    async () => {
      const health = await client.gasHealth();
      return text(
        [
          `Agent gas balance: ${fromUsdc(health.balance / 1_000_000_000_000n)} USDC (approx)`,
          `Payments this affords: about ${health.paymentsLeft}`,
          health.empty
            ? `EMPTY — you cannot submit anything. Tell the owner to fund the agent key.`
            : health.low
              ? `LOW — still working, but tell the owner before it runs out mid-task.`
              : `Healthy.`,
        ].join("\n"),
      );
    },
  );

  const requestPayeeApproval = tool(
    "request_payee_approval",
    "Ask the human owner to add a payee to the allowlist. This is the ONLY way past a " +
      "PAYEE_NOT_ALLOWED refusal — you cannot approve it yourself.",
    {
      serviceId: z.string().describe("The service id you want approved"),
      why: z.string().describe("Why this purchase is worth the owner's attention"),
    },
    async ({serviceId, why}) => {
      const service = findService(serviceId);
      if (!service) return text(`No such service: ${serviceId}`);

      const where = await fileRequest({
        serviceId: service.id,
        serviceName: service.name,
        payee: service.payee,
        amount: formatUsdc(service.price),
        why,
      });

      emit({kind: "escalated", label: service.name, payee: service.payee, why});
      return text(
        `Approval requested from the owner for ${service.name} (${service.payee}).\n` +
          `Reason given: ${why}\n` +
          (where === "service"
            ? `It is now in the owner's queue on the dashboard and on their phone.`
            : `The service was unreachable, so this was queued locally and will only be seen ` +
              `on the dashboard. Mention that in your summary.`) +
          `\nYou cannot proceed until the owner acts. Do not retry.`,
      );
    },
  );

  return [
    listServices,
    checkBudget,
    checkGas,
    payService,
    payAddress,
    resolvePayment,
    requestPayeeApproval,
  ];
}
