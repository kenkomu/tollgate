import {formatUsdc, fromUsdc, Reason, usdc} from "@tollgate/shared";
import {tool} from "@anthropic-ai/claude-agent-sdk";
import {z} from "zod";
import {isAddress, type Address} from "viem";
import {fileRequest} from "./approvals.ts";
import {SERVICES, findService} from "./marketplace.ts";
import {PaymentInFlightError, PaymentRevertedError, type TollgateClient} from "./tollgate.ts";

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
  | {kind: "refused"; label: string; amount: bigint; reason: Reason; message: string}
  | {kind: "escalated"; label: string; payee: Address; why: string};

export type EventSink = (event: AgentEvent) => void;

function text(body: string) {
  return {content: [{type: "text" as const, text: body}]};
}

/**
 * Turn a submission failure into an instruction.
 *
 * A model handed a raw stack trace will do the reasonable-looking thing and try again.
 * For an unresolved payment that is the one genuinely harmful move, so the unknown case
 * says so in the first line and hands back the transaction hash to resolve instead.
 */
function explainSubmissionFailure(error: unknown): string {
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

      const pre = await client.check(service.payee, service.price);
      if (!pre.allowed) {
        emit({
          kind: "refused",
          label: service.name,
          amount: service.price,
          reason: pre.reason,
          message: pre.message,
        });
        return text(
          `REFUSED by policy. Reason: ${pre.reasonName}. ${pre.message}\n` +
            `Nothing was spent.` +
            (pre.reason === Reason.PAYEE_NOT_ALLOWED
              ? `\nThis payee is not on the owner's allowlist. Use request_payee_approval.`
              : ""),
        );
      }

      let receipt;
      try {
        receipt = await client.spend(service.payee, service.price);
      } catch (error) {
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

      const pre = await client.check(payee, value);
      if (!pre.allowed) {
        emit({kind: "refused", label: `direct → ${payee}`, amount: value, reason: pre.reason, message: pre.message});
        return text(`REFUSED by policy. Reason: ${pre.reasonName}. ${pre.message}\nNothing was spent.`);
      }

      let receipt;
      try {
        receipt = await client.spend(payee, value);
      } catch (error) {
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

      await fileRequest({
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
          `The owner must approve this in the Tollgate dashboard. You cannot proceed until they do.`,
      );
    },
  );

  return [listServices, checkBudget, payService, payAddress, requestPayeeApproval];
}
