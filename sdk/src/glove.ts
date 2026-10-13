import {z} from "zod";
import type {Address} from "viem";
import type {TollgateClient} from "./client.ts";
import {ApprovalInbox} from "./approvals.ts";
import {createTools, type ToolOptions} from "./tools.ts";

/**
 * Tollgate tools for Glove (https://glove.dterminal.net).
 *
 * Each entry has the shape Glove's `.fold()` documents: `name`, `description`, a Zod
 * `inputSchema` and an async `do(input, display)`. There is no import of `glove-core`, so the
 * SDK does not depend on it.
 *
 *   for (const t of gloveTools(client, {serviceUrl})) agent.fold(t);
 *
 * UNVERIFIED against a live Glove install. The shapes come from Glove's public docs, which
 * say only that whatever `do` returns is fed back to the model; the `{status, data}` envelope
 * follows their server-side example. This file is the one place to adjust.
 */

/** The slice of Glove's display manager this file uses. */
export interface GloveDisplay {
  pushAndWait(input: unknown): Promise<unknown>;
}

/** What the approval card receives as its slot data, and what it must resolve with. */
export interface ApprovalCardData {
  requestId: string | null;
  payee: Address;
  amount?: string;
  why: string;
}
export interface ApprovalCardResult {
  /** The owner's decision. "approved" only after they signed setPayee in their own wallet. */
  decision: "approved" | "declined";
}

function envelope(ok: boolean, message: string) {
  return {status: ok ? ("success" as const) : ("error" as const), data: {message}};
}

export interface GloveOptions extends ToolOptions {
  /** How long to wait for the owner's setPayee to land after the card says yes. Default 30s. */
  inlineWaitMs?: number;
}

export function gloveTools(client: TollgateClient, options: GloveOptions = {}) {
  const inbox = new ApprovalInbox({client, owner: options.owner, serviceUrl: options.serviceUrl});

  const tools = createTools(client, options).map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: z.object(def.shape),
    async do(input: never, _display?: GloveDisplay) {
      const result = await def.run(input);
      return envelope(result.ok, result.text);
    },
  }));

  /**
   * Inline approval, for a Glove app with a human in the chat.
   *
   * Instead of filing a ticket and waiting for the owner to find it, the request appears as a
   * card in the conversation (`pushAndWait`). The host app renders the card for the slot named
   * `approve_payee_inline`; when the owner approves, the card has them sign `setPayee` in their
   * own wallet and then resolves `{decision: "approved"}`. The key never touches this code or
   * the agent: it lives in the owner's wallet.
   *
   * The card's word is not trusted. After it resolves, this reads the on-chain allowlist and
   * reports what the chain says, so a card that resolves "approved" without a signature still
   * leaves the agent refused, and told so.
   *
   * Without a display (a headless run) it falls back to the inbox: file, notify the phone, and
   * hand the agent an id to check later.
   */
  const inline = {
    name: "approve_payee_inline",
    description:
      "Ask the owner, right here in the conversation, to approve a new payee. Use after a " +
      "PAYEE_NOT_ALLOWED refusal. Waits for the owner's answer; the chain decides the result.",
    inputSchema: z.object({
      address: z.string().describe("The payee you need, 0x-prefixed"),
      amount: z.string().optional().describe('What you intend to pay them, e.g. "2.00"'),
      why: z.string().describe("Why this is worth the owner's attention, in one sentence"),
    }),
    async do(input: {address: string; amount?: string; why: string}, display?: GloveDisplay) {
      const payee = input.address as Address;
      const ticket = await inbox.request({payee, amount: input.amount, why: input.why});

      if (!display) {
        return ticket
          ? envelope(true, `No one is in the chat, so the owner was notified instead. Request id: ${ticket.id}. Check it later with check_approval.`)
          : envelope(false, "No one is in the chat and no Tollgate service is reachable. Tell the owner directly.");
      }

      const data: ApprovalCardData = {requestId: ticket?.id ?? null, payee, amount: input.amount, why: input.why};
      let answer: ApprovalCardResult | undefined;
      try {
        answer = (await display.pushAndWait({input: data})) as ApprovalCardResult;
      } catch {
        return envelope(false, "The owner dismissed the request. Do not pay this address.");
      }

      if (answer?.decision === "declined") return envelope(false, "DECLINED by the owner. Do not pay this address.");

      // Trust the chain, not the card. Give a just-signed transaction a moment to land.
      const status = ticket
        ? await inbox.waitFor(ticket, {timeoutMs: options.inlineWaitMs ?? 30_000, intervalMs: 1_500})
        : (await client.isAllowedPayee(await client.owner(), payee))
          ? "approved"
          : "pending";
      return status === "approved"
        ? envelope(true, "APPROVED on chain. The payee is allowlisted; you may retry the payment.")
        : envelope(false, "The owner said yes but no setPayee has landed on chain yet, so the contract will still refuse. Wait and check again.");
    },
  };

  return [...tools, inline];
}
