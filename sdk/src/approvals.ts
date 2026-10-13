import type {Address} from "viem";
import type {TollgateClient} from "./client.ts";

/**
 * The approval inbox.
 *
 * A strict allowlist means an agent that meets a new payee stops until a human answers. That
 * answer arrives later and from somewhere else (the phone, the dashboard, a wallet), so the
 * agent files a request, gets an id, and comes back to it: Glove calls this pattern an Inbox.
 *
 * Two sources, and they are not equal. The service records what the owner *said*. The chain
 * records what the owner *did*. "Approved" is decided by the chain alone: the payee is on the
 * allowlist or it is not. A request marked approved in the service with no `setPayee` behind
 * it is still pending, because the contract will still refuse it.
 */

export type ApprovalStatus = "pending" | "approved" | "declined";

export interface ApprovalTicket {
  id: string;
  payee: Address;
}

export interface InboxConfig {
  client: TollgateClient;
  /** The Tollgate service. Optional: without it, status comes from the chain only. */
  serviceUrl?: string;
  owner?: Address;
}

export class ApprovalInbox {
  #client: TollgateClient;
  #serviceUrl: string | undefined;
  #owner: Address | undefined;

  constructor(config: InboxConfig) {
    this.#client = config.client;
    this.#serviceUrl = config.serviceUrl?.replace(/\/$/, "");
    this.#owner = config.owner;
  }

  async #ownerAddress(): Promise<Address> {
    this.#owner ??= await this.#client.owner();
    return this.#owner;
  }

  /** File a request. Returns null when no service is configured or reachable. */
  async request(input: {payee: Address; amount?: string; why: string; label?: string}): Promise<ApprovalTicket | null> {
    if (!this.#serviceUrl) return null;
    try {
      const response = await fetch(`${this.#serviceUrl}/approvals`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          payee: input.payee,
          amount: input.amount ?? "",
          why: input.why,
          serviceName: input.label ?? "Direct payment",
        }),
        // Escalating matters; stalling the agent on an unreachable service does not.
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {id: string};
      return {id: body.id, payee: input.payee};
    } catch {
      return null;
    }
  }

  /** Where does this request stand? The chain decides "approved"; the service can only say "declined". */
  async status(ticket: ApprovalTicket): Promise<ApprovalStatus> {
    if (await this.#client.isAllowedPayee(await this.#ownerAddress(), ticket.payee)) return "approved";
    if (!this.#serviceUrl) return "pending";
    try {
      const response = await fetch(`${this.#serviceUrl}/approvals/${encodeURIComponent(ticket.id)}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return "pending";
      const body = (await response.json()) as {outcome: "approved" | "declined" | null};
      return body.outcome === "declined" ? "declined" : "pending";
    } catch {
      return "pending";
    }
  }

  /** Poll until decided or the deadline passes. Pending at the deadline is an answer, not an error. */
  async waitFor(ticket: ApprovalTicket, {timeoutMs = 120_000, intervalMs = 3_000} = {}): Promise<ApprovalStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.status(ticket);
      if (status !== "pending" || Date.now() >= deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    }
  }
}
